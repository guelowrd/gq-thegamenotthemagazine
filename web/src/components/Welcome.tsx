// The attract screen: the city hero, and a blinking CLICK TO START in the middle.

export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="welcome-screen">
      <button className="welcome" onClick={onStart} aria-label="Click to start">
        <img src="/brand/hero-city.webp" alt="" width={1440} height={960} />
        <span className="start" aria-hidden="true">
          Click to start
        </span>
      </button>
    </div>
  );
}
