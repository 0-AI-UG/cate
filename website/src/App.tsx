import React from "react";
import "./index.css";
import { CanvasHero } from "./CanvasHero";

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50">
      <div className="mx-auto px-8 sm:px-12 h-14 flex items-center justify-between">
        <svg viewBox="0 0 389 204" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-5">
          <path d="M274 203.2L307.29 1.79999H388.29L384.51 24.84H329.97L320.5 80.16H342.22H366.34L362.74 103.2H338.62H316.5L304.06 180.16H358.6L355 203.2H314.5H274Z" fill="currentColor"/>
          <path d="M201.264 203.2L230.424 26.5H197.124L201.264 1.3H294.864L290.724 26.5H257.424L228.264 203.2H201.264Z" fill="currentColor"/>
          <path d="M89 133.2L142.1 1.79999H176.3L188 133.2H161.18L159.56 103.5H128.24L117.26 133.2H89ZM136.16 81.9H158.3L157.04 50.22C156.92 45.66 156.68 41.16 156.32 36.72C156.08 32.16 155.9 28.62 155.78 26.1C154.94 28.62 153.8 32.1 152.36 36.54C151.04 40.98 149.54 45.48 147.86 50.04L136.16 81.9Z" fill="currentColor"/>
          <path d="M38.1825 135C29.4225 135 21.9825 133.38 15.8625 130.14C9.7425 126.78 5.3625 122.16 2.7225 116.28C0.0824997 110.28 -0.6375 103.32 0.5625 95.4L9.3825 39.6C10.7025 31.56 13.6425 24.6 18.2025 18.72C22.7625 12.84 28.5825 8.27999 35.6625 5.04C42.8625 1.68 50.8425 0 59.6025 0C68.4825 0 75.9225 1.68 81.9225 5.04C87.9225 8.27999 92.3025 12.84 95.0625 18.72C97.8225 24.6 98.5425 31.56 97.2225 39.6H70.2225C71.1825 34.32 70.4025 30.3 67.8825 27.54C65.3625 24.78 61.4025 23.4 56.0025 23.4C50.6025 23.4 46.2225 24.78 42.8625 27.54C39.5025 30.3 37.3425 34.32 36.3825 39.6L27.5625 95.4C26.7225 100.56 27.5625 104.58 30.0825 107.46C32.6025 110.22 36.5625 111.6 41.9625 111.6C47.3625 111.6 51.7425 110.22 55.1025 107.46C58.4625 104.58 60.5625 100.56 61.4025 95.4H88.4025C87.2025 103.32 84.2625 110.28 79.5825 116.28C75.0225 122.16 69.2025 126.78 62.1225 130.14C55.0425 133.38 47.0625 135 38.1825 135Z" fill="currentColor"/>
        </svg>
        <a
          href="https://github.com/nicepaulhorn/cate"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-white/40 hover:text-white/70 transition-colors flex items-center gap-1.5"
        >
          GitHub
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-50">
            <path d="M1 11L11 1M11 1H4M11 1V8" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </a>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section className="pt-28 pb-10 px-6 text-center">
      <div className="max-w-3xl mx-auto">
        <h1
          className="fade-up text-4xl sm:text-5xl md:text-[56px] font-semibold tracking-[-0.02em] leading-[1.1] text-white mb-5"
          style={{ animationDelay: "0.05s" }}
        >
          The canvas-native terminal for developers.
        </h1>
        <p
          className="fade-up text-base sm:text-lg text-white/35 max-w-md mx-auto leading-relaxed mb-8"
          style={{ animationDelay: "0.15s" }}
        >
          Terminals, editors, and browsers — floating on an infinite zoomable surface.
        </p>
        <div
          className="fade-up flex flex-col items-center gap-2"
          style={{ animationDelay: "0.25s" }}
        >
          <a
            href="#waitlist"
            className="inline-flex items-center gap-2 bg-white text-black text-sm font-medium px-7 py-2.5 rounded-full hover:bg-white/90 transition-colors"
          >
            Get Early Access
          </a>
          <span className="text-xs text-white/20">macOS & Linux</span>
        </div>
      </div>
    </section>
  );
}

export function App() {
  return (
    <div className="min-h-screen bg-[#1E1E24] text-white">
      <Nav />
      <main>
        <Hero />
        <CanvasHero />
      </main>
    </div>
  );
}

export default App;
