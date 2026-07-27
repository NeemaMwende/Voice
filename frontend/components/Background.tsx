export default function Background() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute -top-32 -left-24 h-[420px] w-[420px] rounded-full bg-neon opacity-[0.30] blur-[90px] animate-float" />
      <div className="absolute -bottom-36 -right-16 h-[380px] w-[380px] rounded-full bg-neon2 opacity-[0.28] blur-[90px] animate-float [animation-delay:-5s]" />
      <div className="absolute left-[55%] top-[40%] h-[300px] w-[300px] rounded-full bg-neon3 opacity-[0.16] blur-[90px] animate-float [animation-delay:-9s]" />
    </div>
  );
}
