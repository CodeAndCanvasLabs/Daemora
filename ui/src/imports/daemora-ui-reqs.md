# Daemora UI Requirements Specification

## 1. Overview
Daemora is a high-performance, multi-channel agentic platform. The UI should provide a seamless interface to interact with the local Daemora server, manage tasks, monitor system health, and configure integrations (MCP, Skills, Channels).

## 2. Visual Identity & Aesthetic (AI - Hacker Theme)
The UI follows a **Dark-First, Futuristic/Tech** aesthetic with high-contrast neon accents and "glow" effects.

### 2.1 Color Palette
| Element | Hex Code / Value | Description |
| :--- | :--- | :--- |
| **Main Background** | `#030213` | Deep Indigo (Core) |
| **Override Background** | `bg-slate-950` | Deepest Dark Navy (App Container) |
| **Main Foreground** | `#f0f0f3` | Off-White / Light Grey |
| **Primary Accent** | `#00d9ff` | **Electric Cyan** (Headings, CTAs, Primary Glow) |
| **Secondary Accent** | `#4ECDC4` | **Medium Aquamarine** (Accents, Secondary Glow) |
| **Primary Purple** | `#7C6AFF` | Vibrant Purple |
| **Danger/Horns** | `#ff4458` | Vivid Red (Logo motifs) |
| **Success/Live** | `#00ff88` | Spring Green |
| **Warning/New** | `#ffaa00` | Bright Amber |
| **Muted Surface** | `bg-slate-900` | Tags and minor surfaces |
| **Borders** | `border-slate-800` | Subtle dark borders |

### 2.2 Visual Effects & Gradients
- **Logo Asset:** Use `/Users/umarfarooq/Downloads/Personal/p2/image.png`.
- **Brand Gradient:** `from-white via-[#00d9ff] to-[#4ECDC4]` (Cyan to Teal).
- **Text Gradient:** `from-white via-gray-100 to-gray-300`.
- **Atmospheric Glow:** Large blurred radial gradients (`blur-[128px]`) using `#00d9ff` (20% opacity) and `#4ECDC4` (15% opacity).
- **Starfield:** Background should feature a "StarField" component providing cosmic depth.

### 2.3 Typography
- **Body Font:** Inter (Weights: 400-700) - Clean, modern sans-serif.
- **Code Font:** JetBrains Mono (Weights: 400, 500) - For logs, terminal outputs, and task data.
- **Smoothing:** `scroll-behavior: smooth` enabled globally.

## 3. Core Functionalities

### 3.1 Conversational Interface (Chat)
- **Endpoint:** `POST /chat` (Sync)
- **Features:**
    - Real-time chat with the agent.
    - Markdown support for agent responses.
    - Session persistence (via `sessionId`).
    - Model selection override for specific prompts.
    - Priority setting (1-10).

### 3.2 Task Management & Monitoring
- **Endpoints:** `POST /tasks` (Async), `GET /tasks`, `GET /tasks/:id`
- **Features:**
    - List of recent tasks with status (pending, running, completed, failed).
    - Detailed view for each task:
        - Input/Output.
        - Tool call logs (which tools were used, parameters, duration).
        - Cost breakdown (tokens and estimated USD).
        - Error messages and stack traces.
    - Progress indicators for long-running tasks.

### 3.3 System Configuration
- **Endpoints:** `GET /config`, `GET /channels`, `GET /models`
- **Features:**
    - Toggle channels (Telegram, WhatsApp, etc.).
    - View global settings (Max cost, Permission tiers, Data directories).
    - Select default model.

### 3.4 MCP (Model Context Protocol) Management
- **Endpoints:** `GET /mcp`, `POST /mcp`, `DELETE /mcp/:name`, `POST /mcp/:name/:action`
- **Features:**
    - List configured MCP servers and their connection status.
    - List tools provided by each server.
    - Enable/Disable/Reload servers.
    - Add new servers (Stdio or HTTP/SSE).

### 3.5 Skills & Scheduled Tasks
- **Endpoints:** `GET /skills`, `POST /skills/reload`, `GET /schedules`, `POST /schedules`, `DELETE /schedules/:id`
- **Features:**
    - Browse available agent skills.
    - Reload skill loader.
    - Create and manage Cron-based scheduled tasks.

### 3.6 Safety & Security
- **Endpoints:** `GET /vault/status`, `POST /vault/unlock`, `POST /vault/lock`, `GET /audit`
- **Features:**
    - Unlock/Lock the Secret Vault (passphrase protected).
    - View real-time Audit Log (security events, sensitive tool usage).
    - Localhost-only access enforcement (already implemented server-side).

### 3.7 Cost Management
- **Endpoints:** `GET /costs/today`
- **Features:**
    - Daily cost limit monitoring and visual progress bar.

## 4. Technical Constraints
- **Target Platform:** Desktop-first (Electron or Progressive Web App).
- **Network:** Must only connect to `http://localhost:8081` (or the configured port).
- **Communication:** Standard JSON REST API.

## 5. Security Mandate
The HTTP channel has been secured to accept requests **only from the local device**. The UI must be run on the same machine as the Daemora server. No external access is permitted for this channel.
