<p align="center">
  <a href="https://www.producthunt.com/products/cate?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-cate" target="_blank" rel="noopener noreferrer"><img alt="CATE - Figma like open canvas for development | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1150094&theme=neutral&t=1779630669260"></a>
</p>

<p align="center">
  <img src="assets/cate-logo.svg" alt="Cate" width="240" />
</p>

<h1 align="center">Cate</h1>

<p align="center">
  <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.de.md">Deutsch</a>
</p>

> **Hinweis:** Diese Übersetzung wurde automatisch erstellt und kann Ungenauigkeiten enthalten.

<p align="center">
  Eine unendliche Arbeitsfläche für Code, Terminals, Browser, Dokumente und KI-Agenten.
</p>

<p align="center">
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/v/release/0-AI-UG/cate?style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/0-AI-UG/cate?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/0-AI-UG/cate/actions"><img src="https://img.shields.io/github/actions/workflow/status/0-AI-UG/cate/ci.yml?style=flat-square" alt="CI" /></a>
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/downloads/0-AI-UG/cate/total?style=flat-square" alt="Downloads" /></a>
</p>

---

<p align="center">
  <img src="assets/demo.gif" alt="Cate demo" width="900" />
</p>

Cate ist eine Desktop-IDE auf einer unendlichen Arbeitsfläche. Statt Fenster und Tabs zu stapeln, verteilen Sie Editoren, Terminals, Browser, Dokumente und KI-Agenten im freien Raum und ordnen sie so an, wie Sie über das Projekt denken. Lassen Sie Panels auf der Fläche schweben, docken Sie sie als Tabs und Splits an oder lösen Sie sie in eigene Fenster. Cate stellt alles wieder her, wenn Sie den Ordner erneut öffnen.

## Erste Schritte

Öffnen Sie einen Ordner. Cate macht daraus einen Arbeitsbereich und stellt bei jeder Rückkehr Ihr Layout, die Panel-Positionen und die Terminals wieder her. Rechtsklick auf die Fläche fügt Panels hinzu, `Cmd+K` öffnet die Befehlspalette, und das Ziehen von Panels auf das Dock erzeugt Tabs und Splits. Es sind keine Konfigurationsdateien einzurichten.

## Warum eine Arbeitsfläche?

Alt-Tab reicht, bis Sie ein Dutzend Terminals, sechs offene Dateien, Dokumentation in einem anderen Fenster und über mehrere Desktops verstreute Notizen haben. Ab da wird das Finden des richtigen Fensters zum Engpass.

Cate gibt jedem Projekt eine Arbeitsfläche, die sich merkt, wo Sie die Dinge gelassen haben. Das ist kein Fenstermanager. Tiling-WMs wie Hyprland, Niri und GlazeWM ordnen die Fenster von allem an, was Sie starten; Cate ordnet die Werkzeuge eines einzelnen Projekts an, näher an Figma als an einem WM.

## Was drinsteckt

**Arbeitsfläche und Layout.** Zoomen und verschieben Sie eine unendliche Fläche, docken Sie Panels als Tabs und Splits in vier Zonen an, lösen Sie Panels in separate Fenster und speichern Sie benannte Layouts. Halten Sie mehrere Projekte offen und stellen Sie sie beim Neustart wieder her.

**Editoren und Terminals.** Monaco-Editor-Panels mit Syntaxhervorhebung, Multi-Cursor, Suchen/Ersetzen, Diffs und Markdown-Vorschau. Native xterm.js-Terminals auf Basis von `node-pty`, im Arbeitsbereich verwurzelt, mit automatischer Shell-Erkennung. Dokument-Panels zeigen PDFs, DOCX und Bilder.

**Git.** Ein git-bewusster Dateibaum mit Live-Überwachung und Suche, dazu eine Versionsverwaltungs-Seitenleiste für Staging, Branches, Worktrees, Verlauf und Inline-Diffs. Volltextsuche im Projekt.

**KI-Agenten.** Führen Sie einen integrierten Coding-Agenten (Pi) mit Chat-Threads und Modellgedächtnis pro Thread aus. Verbinden Sie Anthropic, OpenAI Codex, GitHub Copilot, Gemini, OpenRouter, Groq, Mistral, DeepSeek und weitere per OAuth oder API-Key. Installieren Sie Erweiterungen aus dem Marktplatz.

**Navigation.** Flächenweite Suche über Dateien, Terminal-Verlauf und Panel-Titel (`Cmd+Shift+F`). Panel-Umschalter (`Ctrl+Space`). Befehlspalette (`Cmd+K`).

## Installation

Laden Sie eine vorgefertigte Version herunter. Bauen Sie für den täglichen Gebrauch nicht aus dem Quellcode.

| Plattform | Formate | Link |
|----------|---------|------|
| macOS | DMG, ZIP (`arm64`, `x64`) | [Neueste Version](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | NSIS-Installer, ZIP (`x64`) | [Neueste Version](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage, DEB, `tar.gz` (`x64`) | [Neueste Version](https://github.com/0-AI-UG/cate/releases/latest) |

> **macOS:** Veröffentlichte Builds sind notariell beglaubigt. Unsignierte lokale Builds benötigen ggf. `xattr -cr /Applications/Cate.app`.

> **Linux:** Auf dem Steam Deck oder Distributionen mit schreibgeschütztem Root nutzen Sie den `tar.gz`-Build. Startet das AppImage nicht, versuchen Sie `./Cate.AppImage --no-sandbox`.

## Aus dem Quellcode bauen

Für Mitwirkende. Andernfalls die Version oben nutzen.

**Voraussetzungen:**
- [Node.js](https://nodejs.org/) 20 oder 22 LTS (siehe `.nvmrc`). Node 23+ schlägt fehl: `node-pty` hat keine Prebuilds, die native Kompilierung bricht ab.
- npm >= 9
- Python 3 und ein C++-Compiler für `node-pty`:
  - macOS: `xcode-select --install`
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Fedora/RHEL: `sudo dnf install @development-tools gcc-c++ make python3`
  - Arch: `sudo pacman -S base-devel python`
  - Windows: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) mit dem Workload „Desktopentwicklung mit C++"

```bash
git clone https://github.com/0-AI-UG/cate.git
cd cate
npm install

npm run dev          # Dev-Server mit Hot Reload
npm run typecheck
npm test             # Unit-Tests (vitest)
npm run test:e2e     # Playwright-Integrationstests
npm run build        # Produktions-Build
npm run package      # Paketierung für Distribution (:mac, :win, :linux)
```

Die paketierten Binärdateien landen in `release/`.

## Architektur

```text
src/
├── agent/      # Eingebetteter Pi-Coding-Agent: Prozessmanager, Auth, Marktplatz, Panel-UI
├── main/       # Electron-Hauptprozess: IPC, Arbeitsbereiche, Fenster, Updater, Sicherheit
├── preload/    # Kontextisolierte IPC-Brücke
├── renderer/   # React-18-App: Arbeitsfläche, Docking, Panels, Seitenleiste, Stores, Hooks
└── shared/     # IPC-Kanäle und gemeinsame Typen
```

Cate leitet sämtliches IPC über eine kontextisolierte Preload-Brücke. Der Dateisystemzugriff ist auf registrierte Arbeitsbereichs-Wurzeln beschränkt, Browser-Panels deaktivieren die Node-Integration, und Terminals können nicht außerhalb genehmigter Verzeichnisse starten.

**Stack:** Electron 41, React 18, Zustand 5, Monaco 0.52, xterm.js 5.5 + node-pty 1.0, Tailwind 3.4, electron-vite, electron-builder, electron-updater, Sentry. PDFs und DOCX über pdf.js und mammoth, Git über simple-git, Dateiüberwachung über chokidar. Die Agent-Laufzeit ist `@earendil-works/pi`.

## Mitwirken

Siehe [CONTRIBUTING.md](CONTRIBUTING.md). Die Historie Version für Version steht im [CHANGELOG](CHANGELOG.md).

## Star-Verlauf

<a href="https://www.star-history.com/#0-AI-UG/cate&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
  </picture>
</a>

## Lizenz

[MIT](LICENSE)
