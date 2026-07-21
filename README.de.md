<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/cate-logo.svg" />
    <img src="assets/cate-logo-light.svg" alt="Cate" width="140" />
  </picture>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.de.md">Deutsch</a>
</p>

> **Hinweis:** Diese Übersetzung wurde automatisch erstellt und kann Ungenauigkeiten enthalten.

<p align="center">
  Eine IDE auf unendlicher Arbeitsfläche für parallele Coding-Agenten.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/0-AI-UG/cate?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/0-AI-UG/cate/actions"><img src="https://img.shields.io/github/actions/workflow/status/0-AI-UG/cate/ci.yml?style=flat-square" alt="CI" /></a>
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/downloads/0-AI-UG/cate/total?style=flat-square" alt="Downloads" /></a>
</p>

---

<p align="center">
  <img src="assets/demo-canvas.gif" alt="Cate demo" width="900" />
</p>

Cate ist eine Desktop-IDE auf einer unendlichen Arbeitsfläche, gebaut für viele Terminals und Coding-Agenten gleichzeitig. Starten Sie Claude Code, Codex oder einen beliebigen Agenten-CLI in einem Cate-Terminal, und die Arbeitsfläche wird zur Missionskontrolle: Jedes Terminal zeigt, ob sein Agent arbeitet, fertig ist oder auf Sie wartet, und Cate benachrichtigt Sie in dem Moment, in dem einer Ihre Eingabe braucht. Erstellen Sie parallele Git-Worktrees mit einem Klick: Jeder bekommt sein eigenes farbiges Territorium auf der Fläche, sodass fünf Agenten auf fünf Branches fünf klar getrennte Arbeitsstränge bleiben statt eines Stapels von Tabs.

Um diesen Kern herum steht eine vollständige IDE: Monaco-Editoren, eingebettete Browser, Dokumentanzeigen, Git-Werkzeuge und ein integrierter Agent-Chat. Lassen Sie Panels frei auf der Fläche schweben, docken Sie sie als Tabs und Splits an oder lösen Sie sie in eigene Fenster. Cate stellt das gesamte Layout wieder her, wenn Sie den Ordner erneut öffnen.

**Erste Schritte:** Öffnen Sie einen Ordner und er wird zum Arbeitsbereich. Rechtsklick fügt Panels hinzu, `Cmd+K` öffnet die Befehlspalette, Panels aufs Dock ziehen erzeugt Tabs und Splits. Keine Konfigurationsdateien.

## Installation

Laden Sie eine vorgefertigte Version herunter. Bauen Sie für den täglichen Gebrauch nicht aus dem Quellcode.

| Plattform | Formate | Link |
|----------|---------|------|
| macOS | DMG, ZIP (`arm64`, `x64`) | [Neueste Version](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | NSIS-Installer, ZIP (`x64`) | [Neueste Version](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage, DEB, `tar.gz` (`x64`) | [Neueste Version](https://github.com/0-AI-UG/cate/releases/latest) |

## Was drinsteckt

- **Agenten-bewusste Terminals:** Cate klinkt sich per Hooks in die unterstützten Agenten-CLIs ein (Claude Code, Codex, Cursor, Grok, OpenCode, Pi), sodass der Agent selbst Turn-Beginn, Turn-Ende und Berechtigungsabfragen meldet. Das steuert den Panel-Zustand (läuft, wartet, fertig) und die Benachrichtigung, wenn einer eine Antwort braucht. Ein Agent, der keine Hooks sendet, zeigt keinen Status.
- **Agenten-Sitzungen überstehen Neustarts:** Der Hook-Strom trägt die Sitzungs-ID jeder CLI. Öffnen Sie das Projekt erneut, kommen die Terminals mit ihrem Verlauf zurück und der Agent wird mit seinem eigenen Resume-Befehl wieder angehängt. Eine veraltete ID fällt auf eine einfache Shell zurück, statt die falsche Unterhaltung fortzusetzen.
- **Worktrees für parallele Branches:** Beschreiben Sie, woran Sie arbeiten, und Cate legt Worktree und Branch an, ausgehend von einem lokalen oder entfernten Branch oder einer offenen PR. Jeder bekommt eine Farbe, die ihn durch Seitenleiste und Dock-Tabs begleitet, samt Territorium hinter seinen Panels auf der Arbeitsfläche.
- **Panels auf der Fläche oder im Dock:** Terminals, Monaco-Editoren, Browser, PDF-/Bild-/DOCX-Anzeigen, Erweiterungs-Webviews, verschachtelte Flächen. Lassen Sie sie schweben, docken Sie sie als Tabs und Splits an oder ziehen Sie sie in ein eigenes Fenster. Das Layout bleibt pro Projekt erhalten.
- **Git und Suche:** Versionsverwaltungs-Seitenleiste für Staging, Commits, Branches, Stash und Verlauf über mehrere Repos; Git-Markierungen im Dateibaum; Diffs nebeneinander. Ripgrep-Suche über den Arbeitsbereich, und `Cmd+K` für Befehle, Panels und Dateien.
- **Eine CLI, die Agenten aufrufen können:** In einem Cate-Terminal steuert `cate` ein Browser-Panel (`open`, `screenshot`, `snapshot`, `click`, `type`), liest ein anderes Terminal, öffnet Dateien, verwaltet Panels. Einstellungen → CLI gibt jede Fläche getrennt für Lesen und Steuern frei.
- **Lokal und remote gehen denselben Weg:** Ein einziger Runtime-Daemon bedient jeden Arbeitsbereich. Zeigen Sie Cate per SSH oder WSL auf einen Host: Terminals, Git, Suche und Agenten laufen dort; Editoren, Browser und Fläche bleiben lokal.

## Erweiterungen

Cate hat ein Erweiterungssystem für Panels von Drittanbietern (MCP-Server, Diagramme und mehr), jedes in einer eigenen isolierten Webview. Stöbern und bauen Sie im Begleit-Repo: [0-AI-UG/cate-extensions](https://github.com/0-AI-UG/cate-extensions).

## Tastenkürzel

Unten macOS; unter Windows/Linux `Ctrl` statt `Cmd`.

| Panels & Dateien | | Ansicht & Navigation | |
|---|---|---|---|
| Neues Terminal | `Cmd+T` | Befehlspalette | `Cmd+K` |
| Neuer Editor | `Cmd+Shift+E` | Alles durchsuchen | `Cmd+Shift+F` |
| Neuer Browser | `Cmd+Shift+B` | Seitenleiste umschalten | `Cmd+B` |
| Neuer Agent | `Cmd+Shift+A` | Datei-Explorer umschalten | `Cmd+Shift+X` |
| Neue Arbeitsfläche | `Cmd+Shift+C` | Minimap umschalten | `Cmd+Shift+M` |
| Neue Datei | `Cmd+N` | Nächstes / vorheriges Panel | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Datei speichern | `Cmd+S` | Zwischen Panels wechseln | `Cmd+←↑↓→` |
| Panel schließen | `Cmd+W` | Fokussiertes Panel löschen | `Cmd+Backspace` |

| Arbeitsfläche | |
|---|---|
| Hineinzoomen / herauszoomen | `Cmd+=` / `Cmd+-` |
| Zoom zurücksetzen | `Cmd+0` |
| Auf alles / Auswahl zoomen | `Cmd+1` / `Cmd+2` |
| Automatisches Layout | `Cmd+Shift+L` |
| Fläche verschieben | `Shift+←↑↓→` |
| Auswahl-/Hand-Werkzeug umschalten | `Shift+Space` |
| Rückgängig / Wiederholen | `Cmd+Z` / `Cmd+Shift+Z` |

Jedes Tastenkürzel ist in den Einstellungen neu belegbar.

## Aus dem Quellcode bauen

Für Mitwirkende. Andernfalls die Version oben nutzen.

**Voraussetzungen:**
- [Bun](https://bun.sh): Paketmanager und Skript-Runner.
- [Node.js](https://nodejs.org/) 20 oder 22 LTS (siehe `.nvmrc`) im PATH. Die Build-Skripte laufen darunter; der Runtime-Daemon bündelt sein eigenes Node 22.
- **Nur Linux:** `node-pty` liefert vorgebaute Binärdateien für macOS und Windows, aber nicht für Linux, dort wird also aus dem Quellcode kompiliert. Installieren Sie Python 3 und eine C++-Toolchain:
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Fedora/RHEL: `sudo dnf install @development-tools gcc-c++ make python3`
  - Arch: `sudo pacman -S base-devel python`

Frischer Klon, ein Befehl richtet alles ein (installiert Abhängigkeiten und baut den lokalen Runtime-Daemon):

```bash
git clone https://github.com/0-AI-UG/cate.git
cd cate
bun run setup
```

Danach:

```bash
bun run dev          # Dev-Server mit Hot Reload
bun run typecheck
bun run test         # Unit-Tests (vitest)
bun run test:e2e     # Playwright-Integrationstests
bun run build        # Produktions-Build
bun run package      # Paketierung für Distribution (:mac, :win, :linux)
```

Die paketierten Binärdateien landen in `release/`. Der Runtime-Daemon wird mit `bun run runtime:tarball` neu gebaut (nach Änderungen unter `src/runtime/` erneut ausführen).

## Architektur

```text
src/
├── agent/      # Eingebetteter Pi-Coding-Agent: Prozessmanager, Auth, Marktplatz, Panel-UI
├── cli/        # Die `cate`-CLI in Cate-Terminals (Browser-Steuerung, Panels, Editor)
├── main/       # Electron-Hauptprozess: IPC, Arbeitsbereiche, Fenster, Updater, Sicherheit
├── preload/    # Kontextisolierte IPC-Brücke
├── renderer/   # React-18-App: Arbeitsfläche, Docking, Panels, Seitenleiste, Stores, Hooks
├── runtime/    # Runtime-Daemon für Remote-Arbeitsbereiche (SSH): Terminals, Agenten, Suche
└── shared/     # IPC-Kanäle und gemeinsame Typen
```

Cate leitet sämtliches IPC über eine kontextisolierte Preload-Brücke. Der Dateisystemzugriff ist auf registrierte Arbeitsbereichs-Wurzeln beschränkt, Browser-Panels deaktivieren die Node-Integration, und Terminals können nicht außerhalb genehmigter Verzeichnisse starten.

**Stack:** Electron 41, React 18, Zustand 5, Monaco 0.52, xterm.js 5.5 + node-pty 1.0, Tailwind 3.4, electron-vite, electron-builder, electron-updater, Sentry. PDFs und DOCX über pdf.js und mammoth, Git über simple-git, Dateiüberwachung über `@parcel/watcher` und chokidar. Der eingebettete Coding-Agent basiert auf `@earendil-works/pi` und wird als On-Demand-Runtime mit der App ausgeliefert.

## Mitwirken

Siehe [CONTRIBUTING.md](CONTRIBUTING.md). Die Historie Version für Version steht im [CHANGELOG](CHANGELOG.md).

## Star-Verlauf

<a href="https://www.star-history.com/?repos=0-AI-UG%2Fcate&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=0-AI-UG/cate&type=date&theme=dark&legend=top-left&sealed_token=LE-sv5TdJtUmugufglkRue9ZJ6mVXcScJNurvXl9qwGAOHy-taiZA7-UfpBCAHbsxUZESm-1aSxX55u3DTth--kCTUty5gqe7XMhmI-dHz2IOkizZgAk26fW8iovuRbeMSyla3c2T9w9fAj6x2_SZZEGbmvonWJvvLcI-X35nHZFkQQIn_ueBO07uQZM" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=0-AI-UG/cate&type=date&legend=top-left&sealed_token=LE-sv5TdJtUmugufglkRue9ZJ6mVXcScJNurvXl9qwGAOHy-taiZA7-UfpBCAHbsxUZESm-1aSxX55u3DTth--kCTUty5gqe7XMhmI-dHz2IOkizZgAk26fW8iovuRbeMSyla3c2T9w9fAj6x2_SZZEGbmvonWJvvLcI-X35nHZFkQQIn_ueBO07uQZM" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=0-AI-UG/cate&type=date&legend=top-left&sealed_token=LE-sv5TdJtUmugufglkRue9ZJ6mVXcScJNurvXl9qwGAOHy-taiZA7-UfpBCAHbsxUZESm-1aSxX55u3DTth--kCTUty5gqe7XMhmI-dHz2IOkizZgAk26fW8iovuRbeMSyla3c2T9w9fAj6x2_SZZEGbmvonWJvvLcI-X35nHZFkQQIn_ueBO07uQZM" />
 </picture>
</a>

## Lizenz

[MIT](LICENSE)
