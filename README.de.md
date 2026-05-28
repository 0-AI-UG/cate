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
  Eine räumliche Desktop-IDE mit unendlicher Leinwand für Code, Terminals, Browser, Dokumente, KI-Agenten und Git.
</p>

<p align="center">
  <strong>Aktuelle Quellversion:</strong> v1.0.3
</p>

<p align="center">
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/v/release/0-AI-UG/cate?style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/0-AI-UG/cate?style=flat-square" alt="MIT-Lizenz" /></a>
  <a href="https://github.com/0-AI-UG/cate/actions"><img src="https://img.shields.io/github/actions/workflow/status/0-AI-UG/cate/ci.yml?style=flat-square" alt="CI" /></a>
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/downloads/0-AI-UG/cate/total?style=flat-square" alt="Downloads" /></a>
</p>

---

<p align="center">
  <img src="assets/demo.gif" alt="Cate Demo" width="900" />
</p>

Cate ist eine Electron-Desktop-Anwendung zum Anordnen von Entwicklungswerkzeugen im freien Raum. Kombinieren Sie schwebende Canvas-Panels mit angedockten Tabs und Splits, lösen Sie Panels in eigenständige Fenster heraus und halten Sie mehrere Arbeitsbereiche sitzungsübergreifend synchron.

## Erste Schritte

Öffnen Sie einen beliebigen Ordner, um einen Arbeitsbereich zu erstellen — Cate stellt Ihr Canvas-Layout, die Panel-Positionen und geöffnete Terminals bei jedem Neustart wieder her. Klicken Sie mit der rechten Maustaste auf die Leinwand, um Panels hinzuzufügen, drücken Sie `Cmd+K` für die Befehlspalette oder ziehen Sie Panels in das Dock, um Tabs und Splits zu erstellen.

Keine Konfigurationsdateien, keine Projekteinrichtung — richten Sie Cate einfach auf ein Verzeichnis und beginnen Sie zu arbeiten.

## Warum Cate?

Alt-Tab funktioniert gut — bis Sie 12 Terminals, 6 offene Dateien, Dokumentation in einem anderen Fenster und Notizen über verschiedene Desktops verstreut haben. Ab diesem Punkt wird das Fensterwechseln zum eigentlichen Engpass.

Cate ersetzt diesen Fensterstapel durch **eine persistente Leinwand pro Projekt**. Terminals, Editoren, Browser und Notizen bleiben dort, wo Sie sie platziert haben, gruppiert nach Ihrer Denkweise, und sie sind immer noch da, wenn Sie am nächsten Tag zurückkommen.

> Cate ist **kein Ersatz für einen Fenstermanager**. Kachel-/Scroll-WMs (Hyprland, Niri, GlazeWM, KDE) sind großartig, wenn Sie hauptsächlich Betriebssystemfenster anordnen möchten. Cate ist eine räumliche Leinwand um die Werkzeuge eines einzelnen Projekts — näher an Figmas unendlicher Leinwand als an einem WM.

## Funktionen

### 🎨 Leinwand & Layout

- **Unendliche Leinwand** — zoomen, schwenken und Panels überall im freien Raum anordnen. Schwenken mit Zwei-Finger-Drag oder Rechtsklick-Drag; Zoomen mit `Cmd+Scroll` oder den Leinwand-Steuerelementen.
- **Dock-System** — ziehen Sie schwebende Panels in das Dock, um Tabs und Splits zu erstellen. Jede Dock-Zone (Mitte, Links, Rechts, Unten) kann mehrere Tabs mit typfarbigen Icons aufnehmen.
- **Abgelöste Fenster** — lösen Sie Panels oder vollständige Dock-Layouts in separate Betriebssystemfenster heraus.
- **Gespeicherte Layouts** — benennen, speichern, laden und löschen Sie Leinwand-Anordnungen (Knoten und Regionen) über ein In-App-Modal (`Cmd+K → "Gespeicherte Layouts…"`).
- **Multi-Arbeitsbereich-Sitzungen** — halten Sie mehrere Projekte offen und stellen Sie sie beim Neustart wieder her. Wechseln Sie zwischen Arbeitsbereichen über die Seitenleiste.

### 💻 Code, Dokumente & Terminals

- **Monaco-Editor-Panels** — vollwertiges VS-Code-Editing mit Syntaxhervorhebung, Multi-Cursor, Suchen/Ersetzen, Diff-Unterstützung und Markdown-Vorschau/Quellmodus mit GFM-Rendering. Scratch-Editoren behalten ungespeicherte Inhalte sitzungsübergreifend bei.
- **Persistente Editor-Puffer** — dateibasierte Modelle werden panelübergreifend wiederverwendet, und Scratch-Editor-Inhalte bleiben mit der Sitzung erhalten.
- **Dokumenten-Panels** — native Canvas-Viewer für PDFs, DOCX-Dateien und Bilder mit Dateityperkennung basierend auf Magic-Byte-Prüfungen.
- **Native Terminals** — xterm.js mit WebGL-Rendering, unterstützt durch `node-pty`-PTYs, verwurzelt im aktiven Arbeitsbereich. Automatische Shell-Erkennung mit elegantem Fallback, wenn die konfigurierte Shell nicht verfügbar ist.
- **Browser-Panels** — eingebettete Webview-Panels zur Vorschau von Dokumentation, Entwicklungsservern oder beliebigen URLs. Kontextisoliert mit gehärteten Sicherheitseinstellungen.

### 🔧 Git & Quellcodeverwaltung

- **Git-fähiger Dateibrowser** — Dateibaum mit Live-Dateisystemüberwachung, Dimmen von verfolgten/nicht verfolgten Dateien, Suche und Kopieren/Einfügen für Dateien und Ordner mit kollisionssicherer Umbenennung.
- **Quellcodeverwaltungs-Seitenleiste** — Stage/Unstage, Branch-Verwaltung, Worktrees, Commit-Verlauf und Inline-Diff-Ansichten. Der Git-Monitor fragt ab und zeigt Änderungen automatisch an.
- **Projektweite Suche** — Volltextsuche über Arbeitsbereichsdateien mit sofortigen Ergebnissen.

### 🤖 KI-Agent

- **Pi-Agent-Panel** — führen Sie einen In-App-Coding-Agenten aus, der von `@earendil-works/pi-agent-core` angetrieben wird, mit Chat-Threads, modellbezogener Wiederherstellung pro Chat und arbeitsbereichsbewusster Panel-Platzierung.
- **Anbieter-Authentifizierung & Modelle** — verbinden Sie OAuth-Anbieter wie Anthropic, OpenAI Codex und GitHub Copilot oder API-Key-Anbieter wie OpenAI, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek und mehr.
- **Marketplace & Planmodus** — installieren Sie Pi-Erweiterungen aus dem Marketplace und nutzen Sie Cates integrierten Planmodus-Helfer für agentengeführte Implementierungsplanung.

### 🔍 Suche & Navigation

- **Leinwandweite Suche** (`Cmd+Shift+F`) — Spotlight-artiges Overlay, das Arbeitsbereichsdateien, Live-Terminal-Scrollback und geöffnete Panel-Titel/Pfade an einem Ort durchsucht. Ergebnisse nach letztem Fokus sortiert mit typfarbigen Icons.
- **Panel-Umschalter** (`Ctrl+Space`) — kompaktes Tastatur-Overlay zum Springen zwischen geöffneten Canvas-Panels und Zentrieren des ausgewählten Knotens.
- **Befehlspalette** (`Cmd+K`) — schneller Zugriff auf Befehle, geöffnete Panels und Arbeitsbereichsdateien. Einheitliches Spotlight-artiges Design über alle Overlays.

### 🖥️ Desktop-Feinschliff

- **Automatisches Speichern & Sitzungswiederherstellung** — alle Panel-Zustände, Positionen und geöffnete Dateien werden automatisch gespeichert.
- **Optionale native macOS-Fenster-Tabs** — gruppieren Sie Cate-Fenster in der System-Tab-Leiste.
- **Automatische Update-Prüfungen** — prüft GitHub-Releases und benachrichtigt, wenn eine neue Version verfügbar ist.
- **Absturz-Resilienz** — Sentry-Diagnosen, Sitzungswiederherstellungs-Validierung, Shell-Fallback-Banner im PTY und geschützte Update/Neustart-Abläufe helfen, laute oder sich wiederholende Absturzzustände zu vermeiden.

## Installation

Wenn Sie Cate einfach nur verwenden möchten, laden Sie ein vorgefertigtes Release herunter — kompilieren Sie nicht aus dem Quellcode. Dieses Repository zielt derzeit auf **v1.0.3** ab.

| Plattform | Formate | Link |
|-----------|---------|------|
| macOS | DMG, ZIP (`arm64`, `x64`) | [Neueste Version](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | NSIS-Installer, ZIP (`x64`) | [Neueste Version](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage, DEB, `tar.gz` (`x64`) | [Neueste Version](https://github.com/0-AI-UG/cate/releases/latest) |

> **macOS-Hinweis:** Release-Builds sind notarisiert und für gehärtete Laufzeit konfiguriert. Unsignierte lokale oder Test-Builds erfordern möglicherweise:
> ```bash
> xattr -cr /Applications/Cate.app
> ```

> **Linux-Hinweis:** Auf dem Steam Deck oder anderen Distributionen mit schreibgeschütztem Root-Verzeichnis bevorzugen Sie den portablen `tar.gz`-Build. Wenn das AppImage nicht startet, versuchen Sie `--no-sandbox` als Fallback (z.B. `./Cate.AppImage --no-sandbox`).

## Aus dem Quellcode kompilieren

> Die folgenden Schritte sind für **Mitwirkende** — verwenden Sie das vorgefertigte Release oben für den täglichen Gebrauch.

### Voraussetzungen

- [Node.js](https://nodejs.org/) 20 oder 22 LTS (siehe `.nvmrc`). Node 23+ wird nicht unterstützt; `node-pty` hat keine Prebuilds und die native Kompilierung wird fehlschlagen.
- npm >= 9
- Python 3 und ein C++-Compiler (für das native `node-pty`-Modul)
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Fedora/RHEL: `sudo dnf install @development-tools gcc-c++ make python3`
  - Arch: `sudo pacman -S base-devel python`
  - Windows: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (wählen Sie die Workload „Desktopentwicklung mit C++")

### Einrichtung

```bash
git clone https://github.com/0-AI-UG/cate.git
cd cate
npm install
```

### Entwicklung

```bash
npm run dev
```

Dies startet die Electron-App mit Hot Reload über electron-vite.

### Qualitätsprüfungen

```bash
npm run typecheck
npm test            # Unit-Tests (vitest)
npm run test:e2e    # Playwright-Integrationstests
```

Für den Electron-Smoke-Test:

```bash
npm run test:smoke:electron
```

### Produktions-Build

```bash
npm run build
```

### Paketierung für die Verteilung

```bash
npm run package
# oder eine Plattform gezielt ansteuern:
npm run package:mac
npm run package:win
npm run package:linux
```

Die paketierten Binärdateien befinden sich im Verzeichnis `release/`.

## Sicherheit & Paketierung

Cate verwendet eine kontextisolierte Preload-Brücke für die gesamte IPC-Kommunikation. Der Dateisystemzugriff ist auf registrierte Arbeitsbereich-Stammverzeichnisse beschränkt, Browser-Panels verwenden gehärtete Webview-Einstellungen mit deaktivierter Node-Integration, und der Updater öffnet als Fallback die GitHub-Release-Seite, wenn kein verifizierter Installer-Pfad verfügbar ist. Die arbeitsbereichsbezogene `allowedRoots`-Validierung verhindert, dass Terminals außerhalb genehmigter Verzeichnisse gestartet werden.

## Architektur

```text
src/
├── agent/              # Eingebettete Pi-Coding-Agent-Integration
│   ├── main/           # Agent-Prozessmanager, Auth, Marketplace, Sitzungsdateien
│   ├── renderer/       # Agent-Panel-UI, Chat-Thread, Anbieter, Modellpräferenzen
│   └── extensions/     # Cate-gebündelte Planmodus-Pi-Erweiterung
├── main/               # Electron-Hauptprozess
│   ├── ipc/            # IPC-Handler (Dateisystem, Git, Terminal, Menü, Drag)
│   ├── analytics       # Update/App-Event-Analytics-Helfer
│   ├── appContext      # Geteilter Hauptprozess-App-Zustand
│   ├── featureFlags    # Laufzeit-Feature-Flags
│   ├── shellEnv        # Login-Shell-Umgebungserfassung
│   ├── shellResolver   # Shell-Pfadauflösung mit Fallback-Kette
│   ├── workspaceManager# Arbeitsbereich-Lebenszyklus und Sitzungspersistenz
│   ├── workspaceRoots  # Registrierung und Validierung erlaubter Stammverzeichnisse
│   ├── windowRegistry  # Fensterverwaltung (Haupt-, Dock-, abgelöste Fenster)
│   ├── webSecurity     # Webview-Härtung und CSP
│   ├── auto-updater    # Update-Prüfungen und Release-Abruf
│   ├── sentry          # Sentry-Integration
│   ├── store           # electron-store-Persistenz
│   ├── jsonFileStore   # JSON-Datei-Persistenz-Helfer
│   ├── menu            # Anwendungsmenü
│   └── sessionTrust    # Sitzungswiederherstellungs-Validierung
├── preload/            # Kontextisolierte Brücke zum Renderer
├── renderer/           # React 18 Anwendung
│   ├── assets/         # Renderer-Bilder und Asset-Deklarationen
│   ├── canvas/         # Unendliche Leinwand — Rendering, Drag, Resize, Platzierung
│   ├── docking/        # Tabs, Splits, abgelöste Dock-Fenster, Drag & Drop
│   ├── drag/           # Fensterübergreifende Drag-and-Drop-Laufzeit und -Zustand
│   ├── panels/         # Terminal, Editor, Browser, Dokument, Git, Explorer,
│   │                   # Projekte, Canvas-Panel-Registry/Komponenten
│   ├── sidebar/        # Arbeitsbereich, Dateibrowser, Quellcodeverwaltung,
│   │                   # Parallele Arbeit, Projektliste, Datei-Zwischenablage
│   ├── dialogs/        # Gespeicherte Layouts und Post-Update-Feedback-Dialoge
│   ├── settings/       # Einstellungsfenster-Bereiche und Shortcut-Recorder
│   ├── ui/             # Befehlspalette, Globale Suche, Knotenumschalter,
│   │                   # Willkommensseite, Shortcut-Hinweis-Overlay
│   ├── shells/         # Haupt-, Panel- und Dock-Fenster-Shells
│   ├── stores/         # Zustand-Stores (Canvas, App, Dock, Einstellungen,
│   │                   # Shortcut, Status, UI, Update, URL-Prompt)
│   ├── hooks/          # Benutzerdefinierte React-Hooks (Shortcuts, Canvas-Interaktion)
│   ├── lib/            # Hilfsprogramme (Koordinaten, Routing, Terminal-Registry)
│   ├── workers/        # Monaco/Editor-Worker
│   └── styles/         # Tailwind/globale Styles
└── shared/             # IPC-Kanaldefinitionen und geteilte TypeScript-Typen
```

### Technologie-Stack

- **Electron 41** — Desktop-Shell (Chromium + Node.js)
- **React 18** — UI-Framework mit funktionalen Komponenten und Hooks
- **Zustand 5** — leichtgewichtige Zustandsverwaltung (kein Redux/Context)
- **Monaco Editor 0.52** — Code-Bearbeitung (VS Codes Editor-Komponente)
- **xterm.js 5.5 + node-pty 1.0** — Terminal-Emulator mit WebGL-Renderer
- **@earendil-works/pi-Pakete** — eingebettete Coding-Agent-Laufzeit, Anbieter-Auth und Erweiterungs-Marketplace
- **pdf.js + mammoth** — natives PDF- und DOCX-Dokument-Rendering
- **react-markdown + remark-gfm** — Markdown-Vorschau mit GitHub Flavored Markdown
- **simple-git 3.27** — Git-Operationen
- **chokidar 4.0** — Dateisystemüberwachung
- **@phosphor-icons/react** — App-Ikonografie
- **Tailwind CSS 3.4** — Styling
- **electron-vite 5.0** — Bundling mit HMR
- **electron-builder 26** — Paketierung und Verteilung
- **electron-updater 6.8** — Update-Prüfungen
- **Sentry Electron 5** — Absturzmeldungen und Diagnosen
- **Playwright** — End-to-End-Integrationstests
- **Vitest** — Unit-Test-Runner

## Roadmap

Cate wird aktiv weiterentwickelt. Einen detaillierten Verlauf der Änderungen in jeder Version und einen Ausblick finden Sie im [CHANGELOG](CHANGELOG.md).

## Star-Verlauf

<a href="https://www.star-history.com/#0-AI-UG/cate&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
    <img alt="Star-Verlaufsdiagramm" src="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
  </picture>
</a>

## Mitwirken

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für Richtlinien.

## Lizenz

[MIT](LICENSE)
