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

> **Note :** Cette traduction a été générée automatiquement et peut contenir des inexactitudes.

<p align="center">
  Un IDE de bureau spatial avec un canevas infini pour le code, les terminaux, les navigateurs, les documents, les agents IA et git.
</p>

<p align="center">
  <strong>Version source actuelle :</strong> v1.0.3
</p>

<p align="center">
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/v/release/0-AI-UG/cate?style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/0-AI-UG/cate?style=flat-square" alt="Licence MIT" /></a>
  <a href="https://github.com/0-AI-UG/cate/actions"><img src="https://img.shields.io/github/actions/workflow/status/0-AI-UG/cate/ci.yml?style=flat-square" alt="CI" /></a>
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/downloads/0-AI-UG/cate/total?style=flat-square" alt="Téléchargements" /></a>
</p>

---

<p align="center">
  <img src="assets/demo.gif" alt="Démo Cate" width="900" />
</p>

Cate est une application de bureau Electron pour organiser les outils de développement dans un espace libre. Mélangez des panneaux flottants sur le canevas avec des onglets et des divisions ancrés, détachez des panneaux dans des fenêtres autonomes et gardez plusieurs espaces de travail synchronisés entre les sessions.

## Premiers pas

Ouvrez n'importe quel dossier pour créer un espace de travail — Cate restaure la disposition de votre canevas, les positions des panneaux et les terminaux ouverts à chaque fois que vous revenez. Faites un clic droit sur le canevas pour ajouter des panneaux, appuyez sur `Cmd+K` pour la palette de commandes, ou faites glisser les panneaux vers le dock pour créer des onglets et des divisions.

Pas de fichiers de configuration, pas de configuration de projet — pointez simplement Cate vers un répertoire et commencez à travailler.

## Pourquoi Cate ?

Alt-tab fonctionne bien — jusqu'à ce que vous ayez 12 terminaux, 6 fichiers ouverts, de la documentation dans une autre fenêtre et des notes éparpillées sur les bureaux. À ce stade, changer de fenêtre devient le véritable goulot d'étranglement.

Cate remplace cette pile de fenêtres par **un canevas persistant par projet**. Les terminaux, éditeurs, navigateurs et notes restent là où vous les avez placés, groupés comme vous les concevez, et ils sont toujours là quand vous revenez le lendemain.

> Cate **n'est pas un remplacement de gestionnaire de fenêtres**. Les WM à tuiles/défilement (Hyprland, Niri, GlazeWM, KDE) sont excellents si vous souhaitez principalement organiser les fenêtres de l'OS. Cate est un canevas spatial autour des outils d'un seul projet — plus proche du canevas infini de Figma qu'un WM.

## Fonctionnalités

### 🎨 Canevas et disposition

- **Canevas infini** — zoomez, faites défiler et organisez les panneaux n'importe où dans l'espace libre. Défilement avec deux doigts ou clic droit ; zoom avec `Cmd+scroll` ou les contrôles du canevas.
- **Système de dock** — glissez les panneaux flottants vers le dock pour créer des onglets et des divisions. Chaque zone de dock (centre, gauche, droite, bas) peut contenir plusieurs onglets avec des icônes colorées par type.
- **Fenêtres détachées** — extrayez des panneaux ou des dispositions de dock complètes dans des fenêtres OS séparées.
- **Dispositions sauvegardées** — nommez, sauvegardez, chargez et supprimez des arrangements de canevas (nœuds et régions) depuis une modale intégrée (`Cmd+K → "Dispositions sauvegardées…"`).
- **Sessions multi-espaces de travail** — gardez plusieurs projets ouverts et restaurez-les au redémarrage. Basculez entre les espaces de travail depuis la barre latérale.

### 💻 Code, Documents et Terminaux

- **Panneaux Monaco Editor** — édition complète de qualité VS Code avec coloration syntaxique, multi-curseur, rechercher/remplacer, support diff et mode Aperçu/Source Markdown avec rendu GFM. Les éditeurs brouillon conservent le contenu non sauvegardé entre les sessions.
- **Tampons d'éditeur persistants** — les modèles basés sur fichiers sont réutilisés entre les panneaux, et le contenu des éditeurs brouillon persiste avec la session.
- **Panneaux de documents** — visualiseurs natifs sur le canevas pour les PDF, fichiers DOCX et images, avec détection de type de fichier basée sur les octets magiques.
- **Terminaux natifs** — xterm.js avec rendu WebGL, supporté par des PTY `node-pty` enracinés dans l'espace de travail actif. Détection automatique du shell avec repli gracieux si le shell configuré n'est pas disponible.
- **Panneaux navigateur** — panneaux webview intégrés pour prévisualiser la documentation, les serveurs de développement ou toute URL. Isolés avec des paramètres de sécurité renforcés.

### 🔧 Git et Contrôle de Source

- **Explorateur de fichiers compatible git** — arborescence de fichiers avec surveillance en temps réel du système de fichiers, estompage des fichiers suivis/non suivis, recherche, et copier/coller pour les fichiers et dossiers avec renommage sans collision.
- **Barre latérale de contrôle de source** — stage/unstage, gestion des branches, worktrees, historique des commits et vues diff inline. Le moniteur Git interroge et fait remonter les changements automatiquement.
- **Recherche à l'échelle du projet** — recherche en texte intégral dans les fichiers de l'espace de travail avec résultats instantanés.

### 🤖 Agent IA

- **Panneau Pi Agent** — exécutez un agent de codage intégré alimenté par `@earendil-works/pi-agent-core`, avec des fils de discussion, restauration du modèle par discussion et placement de panneaux compatible avec l'espace de travail.
- **Authentification des fournisseurs et modèles** — connectez des fournisseurs OAuth tels qu'Anthropic, OpenAI Codex et GitHub Copilot, ou des fournisseurs par clé API tels qu'OpenAI, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, et plus encore.
- **Marketplace et mode plan** — installez des extensions Pi depuis le marketplace et utilisez l'assistant de mode plan intégré de Cate pour la planification d'implémentation guidée par agent.

### 🔍 Recherche et Navigation

- **Recherche à l'échelle du canevas** (`Cmd+Shift+F`) — overlay de type Spotlight qui recherche les fichiers de l'espace de travail, le scrollback des terminaux en direct et les titres/chemins des panneaux ouverts en un seul endroit. Résultats classés par focus récent avec icônes colorées par type.
- **Sélecteur de panneaux** (`Ctrl+Space`) — overlay clavier compact pour naviguer entre les panneaux ouverts du canevas et centrer le nœud sélectionné.
- **Palette de commandes** (`Cmd+K`) — accès rapide aux commandes, panneaux ouverts et fichiers de l'espace de travail. Chrome unifié de type Spotlight pour tous les overlays.

### 🖥️ Finitions Bureau

- **Sauvegarde automatique et restauration de session** — tout l'état des panneaux, positions et fichiers ouverts persiste automatiquement.
- **Onglets natifs macOS optionnels** — groupez les fenêtres Cate dans la barre d'onglets système.
- **Vérifications automatiques des mises à jour** — vérifie les releases GitHub et notifie quand une nouvelle version est disponible.
- **Résilience aux pannes** — diagnostics Sentry, validation de restauration de session, bannières de repli shell dans le PTY et flux de mise à jour/redémarrage protégés aident à prévenir les états de crash bruyants ou en boucle.

## Installation

Si vous souhaitez simplement utiliser Cate, téléchargez une version précompilée — ne compilez pas depuis les sources. Ce dépôt cible actuellement la **v1.0.3**.

| Plateforme | Formats | Lien |
|------------|---------|------|
| macOS | DMG, ZIP (`arm64`, `x64`) | [Dernière version](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | Installateur NSIS, ZIP (`x64`) | [Dernière version](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage, DEB, `tar.gz` (`x64`) | [Dernière version](https://github.com/0-AI-UG/cate/releases/latest) |

> **Note macOS :** les builds de release sont notariés et configurés pour un runtime renforcé. Les builds locaux ou de test non signés peuvent nécessiter :
> ```bash
> xattr -cr /Applications/Cate.app
> ```

> **Note Linux :** sur Steam Deck ou d'autres distributions avec racine en lecture seule, préférez le build portable `tar.gz`. Si l'AppImage ne se lance pas, essayez `--no-sandbox` comme solution de repli (ex. `./Cate.AppImage --no-sandbox`).

## Compiler depuis les Sources

> Les étapes ci-dessous sont pour les **contributeurs** — utilisez la version précompilée ci-dessus pour un usage quotidien.

### Prérequis

- [Node.js](https://nodejs.org/) 20 ou 22 LTS (voir `.nvmrc`). Node 23+ n'est pas supporté ; `node-pty` n'a pas de prebuilds et la compilation native échouera.
- npm >= 9
- Python 3 et un compilateur C++ (pour le module natif `node-pty`)
  - macOS : Xcode Command Line Tools (`xcode-select --install`)
  - Debian/Ubuntu : `sudo apt install build-essential python3`
  - Fedora/RHEL : `sudo dnf install @development-tools gcc-c++ make python3`
  - Arch : `sudo pacman -S base-devel python`
  - Windows : [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (sélectionnez la charge de travail « Développement Desktop avec C++ »)

### Configuration

```bash
git clone https://github.com/0-AI-UG/cate.git
cd cate
npm install
```

### Développement

```bash
npm run dev
```

Cela démarre l'application Electron avec rechargement à chaud via electron-vite.

### Vérifications de qualité

```bash
npm run typecheck
npm test            # tests unitaires (vitest)
npm run test:e2e    # tests d'intégration Playwright
```

Pour le harnais de test Electron :

```bash
npm run test:smoke:electron
```

### Build de Production

```bash
npm run build
```

### Empaquetage pour la Distribution

```bash
npm run package
# ou cibler une plateforme :
npm run package:mac
npm run package:win
npm run package:linux
```

Les binaires empaquetés seront dans le répertoire `release/`.

## Sécurité et Empaquetage

Cate utilise un pont preload isolé par contexte pour toute communication IPC. L'accès au système de fichiers est limité aux racines d'espace de travail enregistrées, les panneaux navigateur utilisent des paramètres webview renforcés avec intégration Node désactivée, et l'outil de mise à jour replie vers l'ouverture de la page de release GitHub lorsqu'un chemin d'installateur vérifié n'est pas disponible. La validation `allowedRoots` à portée d'espace de travail empêche les terminaux de démarrer en dehors des répertoires approuvés.

## Architecture

```text
src/
├── agent/              # Intégration de l'agent de codage Pi intégré
│   ├── main/           # Gestionnaire de processus agent, auth, marketplace, fichiers de session
│   ├── renderer/       # UI du panneau agent, fil de discussion, fournisseurs, préférences de modèle
│   └── extensions/     # Extension Pi de mode plan intégrée à Cate
├── main/               # Processus principal Electron
│   ├── ipc/            # Gestionnaires IPC (système de fichiers, git, terminal, menu, glisser)
│   ├── analytics       # Helpers d'analytics d'événements mise à jour/app
│   ├── appContext      # État partagé du processus principal
│   ├── featureFlags    # Drapeaux de fonctionnalités à l'exécution
│   ├── shellEnv        # Capture de l'environnement shell de connexion
│   ├── shellResolver   # Résolution de chemin shell avec chaîne de repli
│   ├── workspaceManager# Cycle de vie de l'espace de travail et persistance de session
│   ├── workspaceRoots  # Enregistrement et validation des racines autorisées
│   ├── windowRegistry  # Gestion des fenêtres (principale, dock, détachée)
│   ├── webSecurity     # Renforcement webview et CSP
│   ├── auto-updater    # Vérifications de mise à jour et récupération de release
│   ├── sentry          # Intégration Sentry
│   ├── store           # Persistance electron-store
│   ├── jsonFileStore   # Helpers de persistance de fichiers JSON
│   ├── menu            # Menu de l'application
│   └── sessionTrust    # Validation de restauration de session
├── preload/            # Pont isolé par contexte exposé au renderer
├── renderer/           # Application React 18
│   ├── assets/         # Images et déclarations d'assets du renderer
│   ├── canvas/         # Rendu du canevas infini, glisser, redimensionner, placement
│   ├── docking/        # Onglets, divisions, fenêtres dock détachées, glisser-déposer
│   ├── drag/           # Runtime et état du glisser-déposer inter-fenêtres
│   ├── panels/         # Terminal, Éditeur, Navigateur, Document, Git, Explorateur,
│   │                   # Projets, registre/composants de panneaux Canvas
│   ├── sidebar/        # Espace de travail, Explorateur de fichiers, Contrôle de source,
│   │                   # Travail parallèle, Liste de projets, presse-papiers de fichiers
│   ├── dialogs/        # Dispositions sauvegardées et dialogues de retour post-mise à jour
│   ├── settings/       # Sections de la fenêtre de paramètres et enregistreur de raccourcis
│   ├── ui/             # Palette de commandes, Recherche globale, Sélecteur de nœuds,
│   │                   # Page d'accueil, Overlay d'indices de raccourcis
│   ├── shells/         # Shells de fenêtres principale, panneau et dock
│   ├── stores/         # Stores Zustand (canevas, app, dock, paramètres,
│   │                   # raccourci, statut, ui, mise à jour, invite url)
│   ├── hooks/          # Hooks React personnalisés (raccourcis, interaction canevas)
│   ├── lib/            # Utilitaires (coordonnées, routage, registre de terminaux)
│   ├── workers/        # Workers Monaco/éditeur
│   └── styles/         # Styles Tailwind/globaux
└── shared/             # Définitions de canaux IPC et types TypeScript partagés
```

### Stack Technique

- **Electron 41** — shell de bureau (Chromium + Node.js)
- **React 18** — framework UI avec composants fonctionnels et hooks
- **Zustand 5** — gestion d'état légère (sans Redux/Context)
- **Monaco Editor 0.52** — édition de code (composant éditeur de VS Code)
- **xterm.js 5.5 + node-pty 1.0** — émulateur de terminal avec rendu WebGL
- **Packages @earendil-works/pi** — runtime d'agent de codage intégré, auth fournisseur et marketplace d'extensions
- **pdf.js + mammoth** — rendu natif de documents PDF et DOCX
- **react-markdown + remark-gfm** — aperçu Markdown avec GitHub Flavored Markdown
- **simple-git 3.27** — opérations git
- **chokidar 4.0** — surveillance du système de fichiers
- **@phosphor-icons/react** — iconographie de l'application
- **Tailwind CSS 3.4** — stylisation
- **electron-vite 5.0** — bundling avec HMR
- **electron-builder 26** — empaquetage et distribution
- **electron-updater 6.8** — vérification des mises à jour
- **Sentry Electron 5** — rapports de crash et diagnostics
- **Playwright** — tests d'intégration de bout en bout
- **Vitest** — exécuteur de tests unitaires

## Feuille de Route

Cate est en développement actif. Pour un historique détaillé de ce qui a changé dans chaque version et un aperçu de la direction, consultez le [CHANGELOG](CHANGELOG.md).

## Historique des Étoiles

<a href="https://www.star-history.com/#0-AI-UG/cate&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
    <img alt="Graphique de l'historique des étoiles" src="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
  </picture>
</a>

## Contribuer

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour les directives.

## Licence

[MIT](LICENSE)
