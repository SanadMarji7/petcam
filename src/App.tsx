/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Camera,
  Eye,
  ShieldCheck,
  Server,
  Key,
  Copy,
  Check,
  RefreshCw,
  Terminal,
  Tablet,
  Smartphone,
  ExternalLink,
  Sliders,
  Volume2,
  VolumeX,
  Play,
  Square,
  AlertTriangle,
  Info,
  Layers,
  FileCode,
  Github,
  Zap,
} from 'lucide-react';
import {
  validateIncomingMessage,
  validateKeyRequirement,
  calculateBackoffDelay,
  evaluateWatchdogAction,
  getBitrateProfile,
} from './logic/signalingRules';

// Repository file tree definition for instant inspection & copying
interface RepoFile {
  path: string;
  category: 'Backend' | 'Config' | 'Templates' | 'Frontend' | 'Deployment' | 'Docs';
  description: string;
}

const REPO_FILES: RepoFile[] = [
  { path: 'main.py', category: 'Backend', description: 'FastAPI app, Hub state class, auth handshake, WebSocket relay, security headers' },
  { path: 'config.py', category: 'Config', description: 'Loads config.toml, applies env overrides, validates 32-char key length' },
  { path: 'config.example.toml', category: 'Config', description: 'Example configuration template with hostname, keys, and port' },
  { path: 'templates/cam.html', category: 'Templates', description: 'iPad camera publisher UI with screen-off overlay and status strip' },
  { path: 'templates/watch.html', category: 'Templates', description: 'Viewer page skeleton for Pixel and desktop with controls bar' },
  { path: 'static/manifest.webmanifest', category: 'Frontend', description: 'PWA Web App Manifest for standalone Pixel home screen icon' },
  { path: 'static/css/styles.css', category: 'Frontend', description: 'Shared zero-dependency dark theme for touch iPad & Pixel' },
  { path: 'static/js/common.js', category: 'Frontend', description: 'Signaling WebSocket wrapper with exponential backoff & heartbeat' },
  { path: 'static/js/cam.js', category: 'Frontend', description: 'Camera capture, multi-viewer connection map, wake lock, watchdog' },
  { path: 'static/js/watch.js', category: 'Frontend', description: 'Viewer connection, watchdog frame monitor, auto network-healing' },
  { path: 'dogcam.service', category: 'Deployment', description: 'Production systemd service unit with auto-restart after tailscaled' },
  { path: 'requirements.txt', category: 'Backend', description: 'Pinned production Python dependencies (FastAPI, Uvicorn, Jinja2)' },
  { path: 'README.md', category: 'Docs', description: 'Comprehensive setup guide, Tailscale HTTPS, Guided Access checklist' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<'simulator' | 'code' | 'github' | 'guide'>('simulator');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  // Key generator state
  const [generatedPublisherKey, setGeneratedPublisherKey] = useState('');
  const [generatedViewerKey, setGeneratedViewerKey] = useState('');
  const [hostnameInput, setHostnameInput] = useState('dogcam.tailnet-xyz.ts.net');

  // Simulator state
  const [simMode, setSimMode] = useState<'both' | 'publisher' | 'viewer'>('both');
  const [isPublisherActive, setIsPublisherActive] = useState(false);
  const [isViewerConnected, setIsViewerConnected] = useState(false);
  const [viewerQuality, setViewerQuality] = useState<'auto' | 'high'>('auto');
  const [isViewerMuted, setIsViewerMuted] = useState(true);
  const [isScreenOff, setIsScreenOff] = useState(false);
  const [simulatedStall, setSimulatedStall] = useState(false);
  const [stallSeconds, setStallSeconds] = useState(0);
  const [watchdogLog, setWatchdogLog] = useState<string[]>([]);
  const [activeViewersCount, setActiveViewersCount] = useState(0);

  // Canvas refs for live animated simulated dog stream
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Selected file for code viewer
  const [selectedFilePath, setSelectedFilePath] = useState('README.md');
  const [fileContent, setFileContent] = useState<string>('Loading file content...');

  // Generate cryptographic keys
  const generateKeys = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const gen = (len: number) => {
      let res = '';
      const arr = new Uint8Array(len);
      window.crypto.getRandomValues(arr);
      for (let i = 0; i < len; i++) {
        res += chars[arr[i] % chars.length];
      }
      return res;
    };
    const pub = gen(43);
    const view = gen(43);
    setGeneratedPublisherKey(pub);
    setGeneratedViewerKey(view);
  };

  useEffect(() => {
    generateKeys();
  }, []);

  // Fetch file content when viewing code tab
  useEffect(() => {
    if (activeTab === 'code') {
      fetch(`/${selectedFilePath}`)
        .then((res) => (res.ok ? res.text() : `Could not load ${selectedFilePath}`))
        .then((txt) => setFileContent(txt))
        .catch((err) => setFileContent(`Error loading file: ${err.message}`));
    }
  }, [selectedFilePath, activeTab]);

  // Simulated dog video stream renderer on canvas
  useEffect(() => {
    let frame = 0;
    const render = () => {
      frame++;
      const targets = [canvasRef.current, viewerCanvasRef.current].filter(Boolean) as HTMLCanvasElement[];
      
      for (const canvas of targets) {
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        // Draw background room
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Floor grid
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        for (let i = 0; i < canvas.width; i += 40) {
          ctx.beginPath();
          ctx.moveTo(i, 200);
          ctx.lineTo(i * 1.5 - 50, canvas.height);
          ctx.stroke();
        }

        // Dog bed
        ctx.fillStyle = '#334155';
        ctx.beginPath();
        ctx.ellipse(320, 260, 140, 60, 0, 0, Math.PI * 2);
        ctx.fill();

        // Dog body (subtle breathing animation if not stalled)
        const breath = simulatedStall ? 0 : Math.sin(frame * 0.05) * 3;
        const tailWag = simulatedStall ? 0 : Math.sin(frame * 0.2) * 15;

        // Dog tail
        ctx.strokeStyle = '#b45309';
        ctx.lineWidth = 12;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(250, 240);
        ctx.quadraticCurveTo(220, 230 + tailWag, 200, 210 + tailWag);
        ctx.stroke();

        // Dog main body
        ctx.fillStyle = '#d97706';
        ctx.beginPath();
        ctx.ellipse(310, 240 - breath / 2, 70, 40 + breath, 0, 0, Math.PI * 2);
        ctx.fill();

        // Dog head
        ctx.fillStyle = '#b45309';
        ctx.beginPath();
        ctx.ellipse(370, 210, 32, 28, 0.2, 0, Math.PI * 2);
        ctx.fill();

        // Dog ears
        ctx.fillStyle = '#92400e';
        ctx.beginPath();
        ctx.ellipse(360, 195, 12, 20, -0.3, 0, Math.PI * 2);
        ctx.fill();

        // Snout
        ctx.fillStyle = '#78350f';
        ctx.beginPath();
        ctx.ellipse(395, 218, 16, 12, 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(405, 216, 4, 0, Math.PI * 2);
        ctx.fill();

        // Eyes (blinking occasionally)
        const isBlinking = !simulatedStall && Math.floor(frame / 60) % 5 === 0 && frame % 60 < 6;
        ctx.fillStyle = '#0f172a';
        if (isBlinking) {
          ctx.fillRect(370, 206, 6, 2);
        } else {
          ctx.beginPath();
          ctx.arc(373, 207, 3, 0, Math.PI * 2);
          ctx.fill();
        }

        // Live Timestamp & HUD
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(10, 10, 280, 50);
        ctx.fillStyle = '#10b981';
        ctx.beginPath();
        ctx.arc(24, 28, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = '12px ui-monospace, monospace';
        ctx.fillText(
          `LIVE DOGCAM • ${new Date().toLocaleTimeString()} • ${simulatedStall ? 'STALLED' : '15 FPS'}`,
          36,
          32
        );
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(
          `Encoding: H.264 • Bitrate: ${viewerQuality === 'high' ? '2.0 Mbps' : '800 kbps'}`,
          36,
          48
        );
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [simulatedStall, viewerQuality, isPublisherActive, isViewerConnected, activeTab]);

  // Watchdog simulator loop
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isPublisherActive && isViewerConnected) {
      interval = setInterval(() => {
        if (simulatedStall) {
          setStallSeconds((prev) => {
            const next = prev + 1;
            const action = evaluateWatchdogAction(next, 0);

            if (next === 8) {
              setWatchdogLog((logs) => [
                `[${new Date().toLocaleTimeString()}] WATCHDOG: 8s frame stall detected. Sent viewer_restart (ICE restart)`,
                ...logs.slice(0, 15),
              ]);
            } else if (next === 18) {
              setWatchdogLog((logs) => [
                `[${new Date().toLocaleTimeString()}] WATCHDOG: 18s still stuck. Auto-rebuilding connection pipeline.`,
                ...logs.slice(0, 15),
              ]);
              // Auto recover stall
              setSimulatedStall(false);
              return 0;
            }
            return next;
          });
        } else {
          setStallSeconds(0);
        }
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [simulatedStall, isPublisherActive, isViewerConnected]);

  const copyToClipboard = (text: string, pathLabel?: string) => {
    navigator.clipboard.writeText(text);
    if (pathLabel) {
      setCopiedPath(pathLabel);
      setTimeout(() => setCopiedPath(null), 2000);
    }
  };

  const handleStartPublisher = () => {
    setIsPublisherActive(true);
    setActiveViewersCount(1);
    setIsViewerConnected(true);
    setWatchdogLog((l) => [
      `[${new Date().toLocaleTimeString()}] Publisher: Screen wakeLock requested & active`,
      `[${new Date().toLocaleTimeString()}] Publisher: Camera stream acquired at 720p 15fps`,
      ...l,
    ]);
  };

  const handleStopPublisher = () => {
    setIsPublisherActive(false);
    setIsViewerConnected(false);
    setActiveViewersCount(0);
    setIsScreenOff(false);
    setSimulatedStall(false);
  };

  const generatedConfigToml = `# Petcam configuration file
# Saved at /home/pi/petcam/config.toml

hostname = "${hostnameInput}"
publisher_key = "${generatedPublisherKey || 'PASTE_32_CHAR_PUBLISHER_KEY'}"
viewer_key = "${generatedViewerKey || 'PASTE_32_CHAR_VIEWER_KEY'}"
max_viewers = 4
stun_enabled = false
port = 8000
`;

  return (
    <div className="min-h-screen bg-[#0b0f19] text-slate-100 flex flex-col font-sans">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-[#0f172a]/90 backdrop-blur sticky top-0 z-50 px-4 lg:px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-emerald-500 p-0.5 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <div className="w-full h-full bg-[#0b0f19] rounded-[10px] flex items-center justify-center">
              <Camera className="w-5 h-5 text-emerald-400" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight text-white">petcam</h1>
              <span className="px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-full">
                Self-Hosted WebRTC
              </span>
            </div>
            <p className="text-xs text-slate-400">Tailscale P2P Dog Monitor • iPad to Pixel</p>
          </div>
        </div>

        {/* Tab Controls */}
        <nav className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-1 text-xs">
          <button
            onClick={() => setActiveTab('simulator')}
            className={`px-3 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
              activeTab === 'simulator'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Play className="w-3.5 h-3.5" />
            Interactive Studio
          </button>
          <button
            onClick={() => setActiveTab('code')}
            className={`px-3 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
              activeTab === 'code'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" />
            Repository Files
          </button>
          <button
            onClick={() => setActiveTab('github')}
            className={`px-3 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
              activeTab === 'github'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Github className="w-3.5 h-3.5" />
            GitHub Push
          </button>
          <button
            onClick={() => setActiveTab('guide')}
            className={`px-3 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
              activeTab === 'guide'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Tablet className="w-3.5 h-3.5" />
            iPad Guided Access
          </button>
        </nav>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 lg:p-8 max-w-7xl w-full mx-auto">
        {/* TAB 1: INTERACTIVE SIMULATOR */}
        {activeTab === 'simulator' && (
          <div className="space-y-6">
            {/* Top Toolbar */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-400">View Layout:</span>
                  <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-0.5">
                    <button
                      onClick={() => setSimMode('both')}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                        simMode === 'both' ? 'bg-blue-600 text-white' : 'text-slate-400'
                      }`}
                    >
                      Side by Side
                    </button>
                    <button
                      onClick={() => setSimMode('publisher')}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                        simMode === 'publisher' ? 'bg-blue-600 text-white' : 'text-slate-400'
                      }`}
                    >
                      iPad Only (/cam)
                    </button>
                    <button
                      onClick={() => setSimMode('viewer')}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                        simMode === 'viewer' ? 'bg-blue-600 text-white' : 'text-slate-400'
                      }`}
                    >
                      Pixel Only (/watch)
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${
                      isPublisherActive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                    }`}
                  />
                  <span className="text-xs text-slate-300 font-medium">
                    {isPublisherActive ? 'Publisher Live' : 'Camera Idle'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {!isPublisherActive ? (
                  <button
                    onClick={handleStartPublisher}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow flex items-center gap-2 transition"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    Launch Stream
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => setSimulatedStall((s) => !s)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition flex items-center gap-1.5 ${
                        simulatedStall
                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                          : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5 text-amber-400" />
                      {simulatedStall ? `Stall Active (${stallSeconds}s)` : 'Simulate Frame Stall'}
                    </button>
                    <button
                      onClick={handleStopPublisher}
                      className="px-3 py-1.5 bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/30 text-xs font-semibold rounded-lg transition flex items-center gap-1.5"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      Stop Stream
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Simulated Devices Stage */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Device 1: iPad Publisher (/cam) */}
              {(simMode === 'both' || simMode === 'publisher') && (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl flex flex-col relative overflow-hidden">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                    <div className="flex items-center gap-2">
                      <Tablet className="w-4 h-4 text-blue-400" />
                      <span className="text-xs font-semibold text-slate-200">iPad Publisher</span>
                      <span className="text-[11px] font-mono text-slate-500">/cam</span>
                    </div>
                    {isPublisherActive && (
                      <button
                        onClick={() => setIsScreenOff((s) => !s)}
                        className="px-2.5 py-1 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition"
                      >
                        {isScreenOff ? 'Screen On' : 'Screen Off Mode'}
                      </button>
                    )}
                  </div>

                  {/* iPad Screen Area */}
                  <div className="relative aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
                    {/* Screen-Off Overlay */}
                    {isScreenOff && (
                      <div
                        onClick={() => setIsScreenOff(false)}
                        className="absolute inset-0 bg-black z-30 cursor-pointer flex items-center justify-center group"
                      >
                        <div className="text-center opacity-0 group-hover:opacity-100 transition duration-300">
                          <p className="text-xs text-slate-500">Screen Off Mode Active (Tap to wake)</p>
                          <p className="text-[10px] text-slate-600 mt-1">Camera and WebRTC stream continuing in background</p>
                        </div>
                      </div>
                    )}

                    {isPublisherActive ? (
                      <canvas
                        ref={canvasRef}
                        width={640}
                        height={360}
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <div className="text-center p-6 space-y-3">
                        <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mx-auto text-slate-400">
                          <Camera className="w-6 h-6" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-300">Publisher is Standby</p>
                          <p className="text-xs text-slate-500 max-w-xs mx-auto">
                            Click &quot;Launch Stream&quot; above to activate the camera pipeline and simulate an iPad session.
                          </p>
                        </div>
                        <button
                          onClick={handleStartPublisher}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow transition"
                        >
                          Start iPad Camera
                        </button>
                      </div>
                    )}
                  </div>

                  {/* iPad Status Footer */}
                  <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
                    <div>
                      <span>Status: </span>
                      <strong className={isPublisherActive ? 'text-emerald-400' : 'text-slate-500'}>
                        {isPublisherActive ? 'Streaming' : 'Idle'}
                      </strong>
                    </div>
                    <div>
                      <span>Viewers: </span>
                      <strong className="text-white">{activeViewersCount}</strong>
                    </div>
                    <div>
                      <span>Profile: </span>
                      <strong className="text-slate-300">
                        {getBitrateProfile(viewerQuality).label}
                      </strong>
                    </div>
                  </div>
                </div>
              )}

              {/* Device 2: Google Pixel Viewer (/watch) */}
              {(simMode === 'both' || simMode === 'viewer') && (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl flex flex-col relative overflow-hidden">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                    <div className="flex items-center gap-2">
                      <Smartphone className="w-4 h-4 text-emerald-400" />
                      <span className="text-xs font-semibold text-slate-200">Google Pixel Viewer</span>
                      <span className="text-[11px] font-mono text-slate-500">/watch</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-slate-500 font-mono">PWA Standalone</span>
                    </div>
                  </div>

                  {/* Phone Screen Area */}
                  <div className="relative aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
                    {isViewerConnected && isPublisherActive ? (
                      <div className="w-full h-full relative">
                        {/* Feed mirroring the canvas stream */}
                        <div className="absolute inset-0 flex items-center justify-center">
                          <canvas
                            ref={viewerCanvasRef}
                            width={640}
                            height={360}
                            className="w-full h-full object-contain filter brightness-95"
                          />
                        </div>

                        {/* Stall Warning banner if triggered */}
                        {simulatedStall && (
                          <div className="absolute top-3 left-3 right-3 bg-amber-500/90 text-slate-950 font-semibold text-xs py-1.5 px-3 rounded-lg shadow flex items-center justify-between">
                            <span className="flex items-center gap-1.5">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              Watchdog: Frames stalled ({stallSeconds}s / 8s threshold)
                            </span>
                            <span className="font-mono text-[10px]">Auto-recovering...</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-center p-6 space-y-2">
                        <div className="text-3xl">📹</div>
                        <p className="text-sm font-semibold text-slate-300">Camera is offline</p>
                        <p className="text-xs text-slate-500 max-w-xs mx-auto">
                          Waiting for iPad publisher to start streaming. Reconnects automatically via WebSocket signal.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Bottom Controls Bar */}
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <button
                      onClick={() => setIsViewerMuted((m) => !m)}
                      disabled={!isViewerConnected}
                      className={`flex-1 py-1.5 px-3 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 transition ${
                        isViewerMuted
                          ? 'bg-slate-800 text-slate-300 border-slate-700'
                          : 'bg-emerald-600/20 text-emerald-400 border-emerald-500/40'
                      }`}
                    >
                      {isViewerMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                      {isViewerMuted ? 'Unmute' : 'Muted'}
                    </button>

                    <button
                      onClick={() => setViewerQuality((q) => (q === 'auto' ? 'high' : 'auto'))}
                      disabled={!isViewerConnected}
                      className="flex-1 py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 border border-slate-700 text-xs font-medium flex items-center justify-center gap-1.5 transition"
                    >
                      <Sliders className="w-3.5 h-3.5 text-blue-400" />
                      <span>{viewerQuality === 'high' ? 'High (2 Mbps)' : 'Auto (800 kbps)'}</span>
                    </button>

                    <button
                      onClick={() => {
                        setWatchdogLog((l) => [
                          `[${new Date().toLocaleTimeString()}] Viewer manual reconnect requested. Re-joining socket.`,
                          ...l,
                        ]);
                      }}
                      disabled={!isViewerConnected}
                      className="py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 border border-slate-700 text-xs font-medium flex items-center justify-center gap-1.5 transition"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Reconnect
                    </button>
                  </div>

                  {/* One-Line Status Strip */}
                  <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400">
                    <div>
                      <span>State: </span>
                      <strong className={isViewerConnected ? 'text-emerald-400' : 'text-slate-500'}>
                        {isViewerConnected ? 'Live' : 'Waiting...'}
                      </strong>
                    </div>
                    <div>
                      <span>ICE: </span>
                      <span className="text-slate-300">{isViewerConnected ? 'connected' : 'new'}</span>
                    </div>
                    <div>
                      <span>Feed: </span>
                      <span className="text-slate-300">
                        {isViewerConnected ? (simulatedStall ? '720p @ 0fps' : '720p @ 15fps') : '0x0 @ 0fps'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Watchdog & Signaling Diagnostics Live Log */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                    Signaling Relay & Watchdog Diagnostics
                  </h3>
                </div>
                <span className="text-[11px] text-slate-500 font-mono">
                  Exponential Backoff + 30s Heartbeat Protection
                </span>
              </div>
              <div className="bg-slate-950 border border-slate-800/80 rounded-lg p-3 font-mono text-xs text-slate-300 max-h-40 overflow-y-auto space-y-1">
                {watchdogLog.length === 0 ? (
                  <p className="text-slate-600 italic">No events yet. Start the stream or simulate a stall to observe.</p>
                ) : (
                  watchdogLog.map((log, idx) => (
                    <div
                      key={idx}
                      className={
                        log.includes('WATCHDOG')
                          ? 'text-amber-400'
                          : log.includes('error')
                          ? 'text-red-400'
                          : 'text-slate-300'
                      }
                    >
                      {log}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: REPOSITORY FILES & CODE EXPLORER */}
        {activeTab === 'code' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* File List */}
            <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Project Files ({REPO_FILES.length})
                </h3>
                <span className="text-[11px] text-blue-400 font-mono">Pure Python + Vanilla JS</span>
              </div>
              <div className="space-y-1 max-h-[600px] overflow-y-auto">
                {REPO_FILES.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => setSelectedFilePath(f.path)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono transition flex items-center justify-between ${
                      selectedFilePath === f.path
                        ? 'bg-blue-600/20 text-blue-300 border border-blue-500/40'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <div className="truncate">
                      <p className="font-semibold">{f.path}</p>
                      <p className="text-[10px] text-slate-500 font-sans truncate">{f.description}</p>
                    </div>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-sans shrink-0 ml-2">
                      {f.category}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* File Viewer */}
            <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
              <div className="bg-slate-950 border-b border-slate-800 px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileCode className="w-4 h-4 text-blue-400" />
                  <span className="font-mono text-xs font-semibold text-slate-200">/{selectedFilePath}</span>
                </div>
                <button
                  onClick={() => copyToClipboard(fileContent, selectedFilePath)}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded border border-slate-700 flex items-center gap-1.5 transition"
                >
                  {copiedPath === selectedFilePath ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy Content
                    </>
                  )}
                </button>
              </div>
              <pre className="p-4 bg-[#070b12] text-slate-300 font-mono text-xs overflow-auto max-h-[600px] leading-relaxed">
                <code>{fileContent}</code>
              </pre>
            </div>
          </div>
        )}

        {/* TAB 3: GITHUB PUSH & KEYS GENERATOR */}
        {activeTab === 'github' && (
          <div className="space-y-6">
            {/* Target Repo Banner */}
            <div className="bg-gradient-to-r from-blue-900/40 to-slate-900 border border-blue-500/30 rounded-2xl p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Github className="w-5 h-5 text-blue-400" />
                    <h2 className="text-base font-bold text-white">Target Repository: SanadMarji7/petcam</h2>
                  </div>
                  <p className="text-xs text-slate-300">
                    Ready to push the complete, self-contained codebase to{' '}
                    <code className="text-blue-300 font-mono">https://github.com/SanadMarji7/petcam.git</code>
                  </p>
                </div>
                <button
                  onClick={generateKeys}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow flex items-center gap-2 transition shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Regenerate Auth Keys
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Push Instructions */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-emerald-400" />
                  One-Time Push to GitHub
                </h3>
                <p className="text-xs text-slate-400">
                  Run these commands in your terminal to initialize and push this codebase to your private GitHub repo:
                </p>

                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 relative group">
                  <button
                    onClick={() =>
                      copyToClipboard(
                        `git init\ngit remote add origin https://github.com/SanadMarji7/petcam.git\ngit add .\ngit commit -m "feat: complete self-hosted WebRTC petcam codebase"\ngit branch -M main\ngit push -u origin main`,
                        'git-commands'
                      )
                    }
                    className="absolute top-2.5 right-2.5 p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs transition"
                    title="Copy Git Commands"
                  >
                    {copiedPath === 'git-commands' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <pre className="font-mono text-xs text-emerald-400 overflow-x-auto pr-8 leading-loose">
                    <code>{`git init
git remote add origin https://github.com/SanadMarji7/petcam.git
git add .
git commit -m "feat: complete self-hosted WebRTC petcam codebase"
git branch -M main
git push -u origin main`}</code>
                  </pre>
                </div>

                <div className="text-xs text-slate-400 space-y-1">
                  <p className="font-semibold text-slate-300">What is included:</p>
                  <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                    <li>Stateless FastAPI WebSocket signaling relay (<code className="text-slate-300">main.py</code>)</li>
                    <li>Zero-dependency iPad publisher with hardware H.264 & screen-off mode</li>
                    <li>Pixel viewer with self-healing watchdog on network switch</li>
                    <li>Linux systemd service file (<code className="text-slate-300">dogcam.service</code>)</li>
                    <li>Comprehensive end-to-end setup documentation (<code className="text-slate-300">README.md</code>)</li>
                  </ul>
                </div>
              </div>

              {/* Ready config.toml Generator */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Key className="w-4 h-4 text-amber-400" />
                    Generated config.toml
                  </h3>
                  <button
                    onClick={() => copyToClipboard(generatedConfigToml, 'config-toml')}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded border border-slate-700 flex items-center gap-1.5 transition"
                  >
                    {copiedPath === 'config-toml' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    Copy config.toml
                  </button>
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-slate-400">Tailscale Hostname:</label>
                  <input
                    type="text"
                    value={hostnameInput}
                    onChange={(e) => setHostnameInput(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3">
                  <pre className="font-mono text-xs text-slate-300 overflow-x-auto leading-relaxed">
                    <code>{generatedConfigToml}</code>
                  </pre>
                </div>

                <div className="bg-blue-950/30 border border-blue-500/20 rounded-lg p-3 text-xs text-slate-300 flex items-start gap-2">
                  <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                  <p>
                    These keys use constant-time cryptographic verification (<code className="font-mono text-blue-300">hmac.compare_digest</code>).
                    Any unauthenticated socket is closed immediately with code 4401.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: IPAD GUIDED ACCESS & SETUP GUIDE */}
        {activeTab === 'guide' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <h2 className="text-base font-bold text-white mb-2">iPad Setup Checklist (Unattended Reliability)</h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                Safari suspends <code className="font-mono text-slate-300">getUserMedia</code> camera capture if the tab is backgrounded
                or if the physical power lock button is pressed. This checklist is the proven setup to keep it running for days without touch.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
                  <div className="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 font-bold flex items-center justify-center text-xs">
                    1
                  </div>
                  <h3 className="text-sm font-semibold text-slate-200">Power & Auto-Lock</h3>
                  <p className="text-xs text-slate-400">
                    Plug into wall power on a stand. In iOS <strong className="text-slate-300">Settings → Display & Brightness → Auto-Lock</strong>,
                    set to <strong className="text-emerald-400">Never</strong>. Lower screen brightness.
                  </p>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
                  <div className="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 font-bold flex items-center justify-center text-xs">
                    2
                  </div>
                  <h3 className="text-sm font-semibold text-slate-200">Guided Access Mode</h3>
                  <p className="text-xs text-slate-400">
                    Open <strong className="text-slate-300">Settings → Accessibility → Guided Access</strong> and turn it ON.
                    Open Safari to <code className="font-mono text-blue-300">/cam</code>, tap Start, then <strong className="text-slate-300">triple-click</strong> side button to engage.
                  </p>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
                  <div className="w-7 h-7 rounded-lg bg-amber-500/10 text-amber-400 font-bold flex items-center justify-center text-xs">
                    3
                  </div>
                  <h3 className="text-sm font-semibold text-slate-200">Screen-Off Mode</h3>
                  <p className="text-xs text-slate-400">
                    Tap <strong className="text-slate-300">&quot;Screen Off&quot;</strong> or wait 60s for auto-black mode.
                    The screen turns pure black (#000) to protect the display while streaming continues.
                  </p>
                </div>
              </div>
            </div>

            {/* Tailscale Serve Quick Commands */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                Tailscale HTTPS Commands
              </h2>
              <p className="text-xs text-slate-400">
                Tailscale automatically provides a genuine Let&apos;s Encrypt certificate for your server so Safari can use WebRTC camera permissions:
              </p>

              <div className="space-y-3">
                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-xs text-emerald-400">
                  <code>sudo tailscale serve --bg https / http://127.0.0.1:8000</code>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-xs text-slate-300">
                  <span className="text-slate-500"># Verify systemd service status:</span>
                  <br />
                  <code>sudo systemctl enable --now dogcam</code>
                  <br />
                  <code>sudo journalctl -u dogcam -f</code>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
