export default function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-7">
      <h1 className="text-[26px] font-bold tracking-tight">{title}</h1>
      <p className="text-[13.5px] text-muted mt-1">{subtitle}</p>
    </div>
  );
}
