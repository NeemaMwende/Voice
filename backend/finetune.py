"""Fine-tune deberta-v3-small as the relevance classifier.

    python build_dataset.py     # writes data/relevance-dataset
    python finetune.py          # writes models/relevance-filter

Loads the DatasetDict ``build_dataset.py`` wrote (train / validation / test),
fine-tunes microsoft/deberta-v3-small for binary sequence classification,
evaluates on the held-out test split, and saves the model + tokenizer where
``relevance.py`` looks for them.

The label map is written into the checkpoint as {0: smalltalk, 1: business} —
those are the exact strings the rest of the pipeline uses, and relevance.py
reads the map back out of the config rather than assuming an index, so the two
can never drift apart.

    pip install transformers datasets accelerate sentencepiece scikit-learn

DeBERTa-v3 uses a SentencePiece tokenizer, hence the `sentencepiece` dep. On
CPU this takes a few minutes on a dataset of this size; a GPU takes seconds.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import torch
from datasets import load_from_disk
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    f1_score,
    recall_score,
)
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
)

MODEL_NAME = os.environ.get("RELEVANCE_BASE_MODEL", "microsoft/deberta-v3-small")
HERE = Path(__file__).resolve().parent
DATASET_DIR = Path(
    os.environ.get("RELEVANCE_DATASET_DIR") or HERE / "data" / "relevance-dataset"
)
OUTPUT_DIR = Path(
    os.environ.get("RELEVANCE_MODEL_PATH") or HERE / "models" / "relevance-filter"
)
# Training checkpoints are bulky and disposable; keep them out of the directory
# the backend loads at runtime.
CHECKPOINT_DIR = OUTPUT_DIR.with_name(OUTPUT_DIR.name + "-checkpoints")

# Sentences are short — 128 tokens covers essentially all of them and keeps
# both training and inference fast. relevance.py truncates to the same length.
MAX_LEN = 128
EPOCHS = float(os.environ.get("RELEVANCE_EPOCHS", "4"))
LEARNING_RATE = float(os.environ.get("RELEVANCE_LR", "2e-5"))

ID2LABEL = {0: "smalltalk", 1: "business"}
LABEL2ID = {v: k for k, v in ID2LABEL.items()}


def compute_metrics(eval_pred):
    logits, labels = eval_pred
    preds = np.argmax(logits, axis=-1)
    return {
        "accuracy": accuracy_score(labels, preds),
        "f1": f1_score(labels, preds, average="macro"),
        # Recall on the business class is the number that matters most: a missed
        # business sentence is a requirement dropped from the SOP, whereas a
        # missed pleasantry is cosmetic.
        "business_recall": recall_score(labels, preds, pos_label=1, zero_division=0),
    }


def main() -> None:
    if not DATASET_DIR.exists():
        raise SystemExit(f"No dataset at {DATASET_DIR} — run build_dataset.py first.")

    dataset = load_from_disk(str(DATASET_DIR))
    print({k: len(v) for k, v in dataset.items()})

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

    def tokenize(batch):
        return tokenizer(
            batch["text"],
            truncation=True,
            max_length=MAX_LEN,
            padding=False,  # DataCollatorWithPadding pads per batch (faster)
        )

    tokenized = dataset.map(tokenize, batched=True, remove_columns=["text"])
    tokenized = tokenized.rename_column("label", "labels")

    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_NAME,
        num_labels=2,
        id2label=ID2LABEL,
        label2id=LABEL2ID,
        # deberta-v3-small is published in fp16 and transformers >= 5 honours
        # that on load. Half-precision *backward* isn't supported on most CPUs
        # ("DNNL does not support bf16/f16 backward"), so train in fp32 and let
        # the fp16 flag below handle mixed precision where there's a GPU.
        dtype=torch.float32,
    )

    args = TrainingArguments(
        output_dir=str(CHECKPOINT_DIR),
        num_train_epochs=EPOCHS,
        per_device_train_batch_size=32,
        per_device_eval_batch_size=64,
        learning_rate=LEARNING_RATE,
        warmup_ratio=0.1,
        weight_decay=0.01,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        greater_is_better=True,
        # fp16 only helps on CUDA; on CPU it is either ignored or slower.
        fp16=torch.cuda.is_available(),
        logging_steps=50,
        report_to="none",
        seed=42,
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=tokenized["train"],
        eval_dataset=tokenized["validation"],
        data_collator=DataCollatorWithPadding(tokenizer=tokenizer),
        compute_metrics=compute_metrics,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=2)],
        # `processing_class` on transformers >= 4.46, `tokenizer` before it.
        # Passing the wrong one is a TypeError, so pick by signature.
        **_tokenizer_kwarg(tokenizer),
    )

    trainer.train()

    # ── Held-out test split ─────────────────────────────────────────────────
    results = trainer.evaluate(tokenized["test"])
    print(
        f"\nTest — accuracy={results['eval_accuracy']:.3f}  "
        f"f1={results['eval_f1']:.3f}  "
        f"business_recall={results['eval_business_recall']:.3f}"
    )

    preds = np.argmax(trainer.predict(tokenized["test"]).predictions, axis=-1)
    print(
        "\n"
        + classification_report(
            tokenized["test"]["labels"],
            preds,
            target_names=[ID2LABEL[0], ID2LABEL[1]],
            digits=3,
        )
    )

    # ── Save where relevance.py looks ───────────────────────────────────────
    OUTPUT_DIR.parent.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(OUTPUT_DIR))
    tokenizer.save_pretrained(str(OUTPUT_DIR))
    (OUTPUT_DIR / "test_metrics.json").write_text(
        json.dumps(
            {
                "base_model": MODEL_NAME,
                "dataset": str(DATASET_DIR),
                "splits": {k: len(v) for k, v in dataset.items()},
                "accuracy": results["eval_accuracy"],
                "macro_f1": results["eval_f1"],
                "business_recall": results["eval_business_recall"],
            },
            indent=2,
        )
    )
    print(f"\nModel saved to {OUTPUT_DIR}")
    print("The backend picks it up on its next start — nothing else to change.")


def _tokenizer_kwarg(tokenizer) -> dict:
    """Name the Trainer expects for its tokenizer, across transformers versions."""
    import inspect

    params = inspect.signature(Trainer.__init__).parameters
    if "processing_class" in params:
        return {"processing_class": tokenizer}
    return {"tokenizer": tokenizer}


if __name__ == "__main__":
    main()
