/* =====================================================================
   HIGHWAY RUSH — script.js
   Modular vanilla-JS highway racer. No external image/audio assets are
   required: vehicles/obstacles/collectibles are drawn with CSS, and
   sound effects are synthesized with the Web Audio API. If real image
   files are later added under /images (see README), swapping them in
   is a one-line change per entity type (see VEHICLE_IMAGES below).
   ===================================================================== */

(() => {
    "use strict";

    /* ---------------------------------------------------------------
       0. OPTIONAL IMAGE OVERRIDES
       Fill any of these with a path (e.g. "images/player-car.png") to
       use a real asset instead of the CSS-drawn fallback. Missing or
       broken paths silently fall back to CSS — the game never breaks.
       --------------------------------------------------------------- */
    const VEHICLE_IMAGES = {
        player: null,
        car: null,
        fast: null,
        truck: null,
        bus: null,
        police: null,
    };

    function applyImageFallback(el, key) {
        const src = VEHICLE_IMAGES[key];
        if (!src) return;
        const test = new Image();
        test.onload = () => {
            el.style.backgroundImage = `url("${src}")`;
            el.style.backgroundSize = "100% 100%";
            el.style.backgroundColor = "transparent";
        };
        test.onerror = () => { /* keep CSS fallback, no console errors */ };
        test.src = src;
    }

    /* ---------------------------------------------------------------
       1. CONFIG
       --------------------------------------------------------------- */
    const CONFIG = {
        laneCount: 4,
        playerW: 44,
        playerH: 82,
        lateralSpeed: 6.4,          // px / 16.6ms frame
        cruiseSpeedKmh: 90,
        minSpeedKmh: 35,
        maxSpeedKmh: 190,
        nitroSpeedKmh: 250,
        accelRate: 2.4,
        brakeRate: 3.4,
        driftRate: 0.9,             // pull toward cruise speed
        nitroDuration: 3000,
        fuelDrainPerSec: 0.55,
        fuelWarn: 20,
        speedBreakerRecover: 1300,
        oilSlideDuration: 1600,
        levelScoreStep: 3000,
        maxLevel: 10,
    };

    const GameState = {
        MENU: "MENU",
        COUNTDOWN: "COUNTDOWN",
        PLAYING: "PLAYING",
        PAUSED: "PAUSED",
        LEVEL_COMPLETE: "LEVEL_COMPLETE",
        GAME_OVER: "GAME_OVER",
    };

    /* ---------------------------------------------------------------
       2. STORAGE
       --------------------------------------------------------------- */
    const Storage = {
        key: "highwayRushSave",
        defaults: {
            bestScore: 0,
            bestLevel: 1,
            totalCoins: 0,
            bestDistance: 0,
            achievements: {},
            stats: { overtakes: 0, nearMisses: 0, nitroUses: 0, coinsAllTime: 0 },
        },
        load() {
            try {
                const raw = localStorage.getItem(this.key);
                if (!raw) return structuredCloneSafe(this.defaults);
                const parsed = JSON.parse(raw);
                return Object.assign(structuredCloneSafe(this.defaults), parsed);
            } catch (e) {
                return structuredCloneSafe(this.defaults);
            }
        },
        save(data) {
            try { localStorage.setItem(this.key, JSON.stringify(data)); }
            catch (e) { /* storage unavailable — fail silently */ }
        },
    };
    function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

    /* ---------------------------------------------------------------
       3. SOUND MANAGER (synthesized — no files required)
       --------------------------------------------------------------- */
    class SoundManager {
        constructor() {
            this.ctx = null;
            this.muted = false;
        }
        ensureCtx() {
            if (this.ctx) return;
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                this.ctx = new AC();
            } catch (e) { this.ctx = null; }
        }
        blip(freq, duration, type = "sine", vol = 0.18, sweepTo = null) {
            if (this.muted) return;
            this.ensureCtx();
            if (!this.ctx) return;
            try {
                const t0 = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.type = type;
                osc.frequency.setValueAtTime(freq, t0);
                if (sweepTo) osc.frequency.linearRampToValueAtTime(sweepTo, t0 + duration);
                gain.gain.setValueAtTime(vol, t0);
                gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
                osc.connect(gain).connect(this.ctx.destination);
                osc.start(t0);
                osc.stop(t0 + duration + 0.02);
            } catch (e) { /* ignore */ }
        }
        coin() { this.blip(880, 0.12, "triangle", 0.15, 1320); }
        nitro() { this.blip(220, 0.35, "sawtooth", 0.12, 60); }
        powerup() { this.blip(520, 0.25, "sine", 0.15, 900); }
        speedbreaker() { this.blip(140, 0.2, "square", 0.12, 90); }
        crash() { this.blip(90, 0.4, "sawtooth", 0.22, 40); }
        click() { this.blip(600, 0.06, "square", 0.08); }
        gameover() { this.blip(300, 0.6, "sawtooth", 0.16, 60); }
        levelup() { this.blip(440, 0.3, "triangle", 0.16, 880); }
        toggleMute() { this.muted = !this.muted; return this.muted; }
    }

    /* ---------------------------------------------------------------
       4. UTIL
       --------------------------------------------------------------- */
    const rand = (a, b) => a + Math.random() * (b - a);
    const randInt = (a, b) => Math.floor(rand(a, b + 1));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    /* =================================================================
       5. MAIN GAME CLASS
       ================================================================= */
    class Game {
        constructor() {
            // DOM refs
            this.carGameEl = document.getElementById("carGame");
            this.gameArea = document.getElementById("gameArea");
            this.hud = document.getElementById("hud");
            this.toastStack = document.getElementById("toastStack");
            this.countdownEl = document.getElementById("countdown");
            this.mobileControls = document.getElementById("mobileControls");

            this.screens = {
                start: document.getElementById("startScreen"),
                howTo: document.getElementById("howToScreen"),
                scores: document.getElementById("scoresScreen"),
                pause: document.getElementById("pauseScreen"),
                levelComplete: document.getElementById("levelCompleteScreen"),
                gameOver: document.getElementById("gameOverScreen"),
            };

            this.sound = new SoundManager();
            this.save = Storage.load();

            this.state = GameState.MENU;
            this.keys = {};
            this.rafId = null;
            this.lastTime = 0;

            this.entities = { enemies: [], obstacles: [], collectibles: [], lines: [] };
            this.player = null;

            this.spawnTimers = { enemy: 0, obstacle: 0, collectible: 0 };

            this._bindUI();
            this._bindInput();
            this._renderMenuStats();
            this._detectMobile();
        }

        /* ---------------- UI wiring ---------------- */
        _bindUI() {
            const $ = (id) => document.getElementById(id);
            $("startBtn").addEventListener("click", () => { this.sound.click(); this.beginCountdown(); });
            $("howToBtn").addEventListener("click", () => { this.sound.click(); this._show("howTo"); });
            $("howToCloseBtn").addEventListener("click", () => { this.sound.click(); this._hide("howTo"); });
            $("scoresBtn").addEventListener("click", () => { this.sound.click(); this._renderMenuStats(); this._show("scores"); });
            $("scoresCloseBtn").addEventListener("click", () => { this.sound.click(); this._hide("scores"); });

            $("pauseBtn").addEventListener("click", () => this.togglePause());
            $("resumeBtn").addEventListener("click", () => this.togglePause());
            $("restartFromPauseBtn").addEventListener("click", () => this.restart());
            $("homeFromPauseBtn").addEventListener("click", () => this.goHome());

            $("nextLevelBtn").addEventListener("click", () => this.continueAfterLevel());

            $("playAgainBtn").addEventListener("click", () => this.restart());
            $("mainMenuBtn").addEventListener("click", () => this.goHome());
        }

        _bindInput() {
            const map = {
                ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
                w: "up", s: "down", a: "left", d: "right",
                W: "up", S: "down", A: "left", D: "right",
            };
            window.addEventListener("keydown", (e) => {
                if (map[e.key]) { this.keys[map[e.key]] = true; e.preventDefault(); }
                if (e.key === " ") { this.keys.nitro = true; e.preventDefault(); }
                if (e.key === "p" || e.key === "P") this.togglePause();
                if (e.key === "r" || e.key === "R") { if (this.state === GameState.GAME_OVER) this.restart(); }
            });
            window.addEventListener("keyup", (e) => {
                if (map[e.key]) this.keys[map[e.key]] = false;
                if (e.key === " ") this.keys.nitro = false;
            });

            // mobile d-pad + nitro
            document.querySelectorAll(".dpadBtn").forEach((btn) => {
                const dirMap = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
                const dir = dirMap[btn.dataset.key];
                const on = (ev) => { ev.preventDefault(); this.keys[dir] = true; };
                const off = (ev) => { ev.preventDefault(); this.keys[dir] = false; };
                btn.addEventListener("touchstart", on, { passive: false });
                btn.addEventListener("touchend", off, { passive: false });
                btn.addEventListener("mousedown", on);
                btn.addEventListener("mouseup", off);
                btn.addEventListener("mouseleave", off);
            });
            const nitroBtn = document.getElementById("nitroBtn");
            const nOn = (ev) => { ev.preventDefault(); this.keys.nitro = true; };
            const nOff = (ev) => { ev.preventDefault(); this.keys.nitro = false; };
            nitroBtn.addEventListener("touchstart", nOn, { passive: false });
            nitroBtn.addEventListener("touchend", nOff, { passive: false });
            nitroBtn.addEventListener("mousedown", nOn);
            nitroBtn.addEventListener("mouseup", nOff);
        }

        _detectMobile() {
            const isTouch = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
            if (isTouch) this.mobileControls.classList.remove("hide");
        }

        _show(name) { this.screens[name].classList.remove("hide"); }
        _hide(name) { this.screens[name].classList.add("hide"); }
        _hideAllScreens() { Object.keys(this.screens).forEach((k) => this._hide(k)); }

        _renderMenuStats() {
            document.getElementById("bestScoreValue").textContent = this.save.bestScore.toLocaleString();
            document.getElementById("bestLevelValue").textContent = this.save.bestLevel;
            document.getElementById("bestCoinsValue").textContent = this.save.stats.coinsAllTime.toLocaleString();
            document.getElementById("bestDistanceValue").textContent = this.save.bestDistance.toFixed(1);
            document.getElementById("bestInline").textContent = this.save.bestScore.toLocaleString();
            this._renderAchievements();
        }

        _renderAchievements() {
            const list = document.getElementById("achieveList");
            list.innerHTML = "";
            ACHIEVEMENTS.forEach((a) => {
                const unlocked = !!this.save.achievements[a.id];
                const span = document.createElement("span");
                span.className = "badge" + (unlocked ? "" : " locked");
                span.textContent = `${a.icon} ${a.name}`;
                list.appendChild(span);
            });
        }

        /* ---------------- toast helper ---------------- */
        toast(text, cls = "") {
            const el = document.createElement("div");
            el.className = "toast " + cls;
            el.textContent = text;
            this.toastStack.appendChild(el);
            setTimeout(() => el.remove(), 1000);
        }

        unlockAchievement(id) {
            if (this.save.achievements[id]) return;
            this.save.achievements[id] = true;
            const a = ACHIEVEMENTS.find((x) => x.id === id);
            if (a) this.toast(`🏆 ${a.name}`, "achievement");
            Storage.save(this.save);
        }

        /* ---------------- flow control ---------------- */
        goHome() {
            this._stopLoop();
            this._clearEntities();
            this._hideAllScreens();
            this.hud.classList.add("hide");
            this._show("start");
            this._renderMenuStats();
            this.state = GameState.MENU;
        }

        beginCountdown() {
            this._hideAllScreens();
            this.hud.classList.remove("hide");
            this._setupRun();
            this.state = GameState.COUNTDOWN;
            let n = 3;
            this.countdownEl.classList.remove("hide");
            this.countdownEl.textContent = n;
            const step = () => {
                n -= 1;
                if (n > 0) {
                    this.countdownEl.textContent = n;
                    this.countdownEl.style.animation = "none";
                    void this.countdownEl.offsetWidth;
                    this.countdownEl.style.animation = "";
                    setTimeout(step, 700);
                } else {
                    this.countdownEl.textContent = "GO!";
                    setTimeout(() => {
                        this.countdownEl.classList.add("hide");
                        this.startRun();
                    }, 500);
                }
            };
            setTimeout(step, 700);
        }

        _setupRun() {
            this._clearEntities();
            this.gameArea.innerHTML = "";

            this.run = {
                score: 0,
                coins: 0,
                lives: 3,
                fuel: 100,
                level: 1,
                distanceKm: 0,
                speedKmh: CONFIG.cruiseSpeedKmh,
                nitroCharges: 1,
                nitroActive: false,
                nitroTimer: 0,
                shield: false,
                speedBreakerLock: 0,
                oilSlideTimer: 0,
                oilDir: 1,
                overtakes: 0,
                nearMisses: 0,
                nitroUses: 0,
                env: "day",
                weather: "sunny",
            };

            // lane markings
            const roadRect = this.gameArea.getBoundingClientRect();
            for (let i = 0; i < 6; i++) {
                const line = document.createElement("div");
                line.className = "laneLine";
                line.style.left = "50%";
                line.style.transform = "translateX(-50%)";
                line._y = i * 140 - 140;
                line.style.top = line._y + "px";
                this.gameArea.appendChild(line);
                this.entities.lines.push(line);
            }

            // player
            const playerEl = document.createElement("div");
            playerEl.className = "playerCar vehicle";
            playerEl.innerHTML = `
                <span class="headlight l"></span><span class="headlight r"></span>
                <span class="brakelight l"></span><span class="brakelight r"></span>`;
            applyImageFallback(playerEl, "player");
            this.gameArea.appendChild(playerEl);

            this.player = {
                el: playerEl,
                w: CONFIG.playerW,
                h: CONFIG.playerH,
                x: roadRect.width / 2 - CONFIG.playerW / 2,
                y: roadRect.height - CONFIG.playerH - 70,
            };
            playerEl.style.width = this.player.w + "px";
            playerEl.style.height = this.player.h + "px";
            playerEl.style.left = this.player.x + "px";
            playerEl.style.top = this.player.y + "px";

            this._applyEnvironment();
            this._updateHUD(true);
        }

        startRun() {
            this.state = GameState.PLAYING;
            this.lastTime = performance.now();
            this._loop(this.lastTime);
        }

        togglePause() {
            if (this.state === GameState.PLAYING) {
                this.state = GameState.PAUSED;
                this._stopLoop();
                this._show("pause");
            } else if (this.state === GameState.PAUSED) {
                this._hide("pause");
                this.state = GameState.PLAYING;
                this.lastTime = performance.now();
                this._loop(this.lastTime);
            }
        }

        restart() {
            this._hideAllScreens();
            this.hud.classList.remove("hide");
            this.beginCountdown();
        }

        continueAfterLevel() {
            this._hide("levelComplete");
            this.state = GameState.PLAYING;
            this.lastTime = performance.now();
            this._loop(this.lastTime);
        }

        _stopLoop() {
            if (this.rafId) cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }

        _clearEntities() {
            this.entities.enemies.forEach((e) => e.el.remove());
            this.entities.obstacles.forEach((o) => o.el.remove());
            this.entities.collectibles.forEach((c) => c.el.remove());
            this.entities.lines.forEach((l) => l.remove());
            this.entities = { enemies: [], obstacles: [], collectibles: [], lines: [] };
            this.spawnTimers = { enemy: 0, obstacle: 0, collectible: 0 };
        }

        /* ---------------- main loop ---------------- */
        _loop(ts) {
            this.rafId = requestAnimationFrame((t) => this._loop(t));
            let dt = ts - this.lastTime;
            this.lastTime = ts;
            dt = clamp(dt, 0, 48); // guard against tab-switch jumps
            this._update(dt);
        }

        _update(dt) {
            const run = this.run;
            const road = this.gameArea.getBoundingClientRect();
            const roadWidth = road.width;
            const roadHeight = road.height;

            /* ---- speed model ---- */
            if (run.speedBreakerLock > 0) {
                run.speedBreakerLock -= dt;
            } else if (this.keys.up) {
                run.speedKmh += CONFIG.accelRate * (dt / 16.67);
            } else if (this.keys.down) {
                run.speedKmh -= CONFIG.brakeRate * (dt / 16.67);
            } else {
                const target = CONFIG.cruiseSpeedKmh + run.level * 4;
                run.speedKmh += (target - run.speedKmh) * 0.02 * (dt / 16.67);
            }

            let maxSpeed = CONFIG.maxSpeedKmh + run.level * 3;
            if (run.nitroActive) maxSpeed = CONFIG.nitroSpeedKmh;
            run.speedKmh = clamp(run.speedKmh, CONFIG.minSpeedKmh, maxSpeed);

            /* ---- nitro ---- */
            if (this.keys.nitro && !run.nitroActive && run.nitroCharges > 0) {
                run.nitroActive = true;
                run.nitroTimer = CONFIG.nitroDuration;
                run.nitroCharges -= 1;
                run.nitroUses += 1;
                this.sound.nitro();
                this.player.el.querySelector(".nitroFlame")?.remove();
                const flame = document.createElement("div");
                flame.className = "nitroFlame";
                this.player.el.appendChild(flame);
                this._checkAchievement();
            }
            if (run.nitroActive) {
                run.nitroTimer -= dt;
                run.speedKmh = Math.max(run.speedKmh, CONFIG.nitroSpeedKmh - 20);
                if (run.nitroTimer <= 0) {
                    run.nitroActive = false;
                    this.player.el.querySelector(".nitroFlame")?.remove();
                }
            }

            /* ---- lateral movement ---- */
            let lateral = CONFIG.lateralSpeed * (dt / 16.67);
            if (run.oilSlideTimer > 0) {
                run.oilSlideTimer -= dt;
                lateral *= 0.4;
                this.player.x += Math.sin(performance.now() / 90) * 2.4 * run.oilDir;
            }
            if (this.keys.left) this.player.x -= lateral;
            if (this.keys.right) this.player.x += lateral;
            this.player.x = clamp(this.player.x, 6, roadWidth - this.player.w - 6);

            const tilt = this.keys.left ? "tilt-left" : this.keys.right ? "tilt-right" : "";
            this.player.el.classList.toggle("tilt-left", tilt === "tilt-left");
            this.player.el.classList.toggle("tilt-right", tilt === "tilt-right");
            this.player.el.style.left = this.player.x + "px";

            const scroll = (run.speedKmh / 12) * (dt / 16.67);

            /* ---- world scroll: lane lines ---- */
            this.entities.lines.forEach((line) => {
                line._y += scroll;
                if (line._y > roadHeight) line._y -= roadHeight + 140;
                line.style.top = line._y + "px";
            });

            /* ---- spawn timers ---- */
            this._tickSpawns(dt, roadWidth);

            /* ---- move + collide: enemies ---- */
            this._updateEnemies(scroll, roadHeight, roadWidth);
            this._updateObstacles(scroll, roadHeight, roadWidth);
            this._updateCollectibles(scroll, roadHeight, roadWidth);

            /* ---- fuel & distance & score ---- */
            run.fuel -= CONFIG.fuelDrainPerSec * (dt / 1000);
            run.distanceKm += (run.speedKmh * dt) / 3600000;
            run.score += 10 * (dt / 1000) * (1 + run.level * 0.08);

            if (run.fuel <= 0) { run.fuel = 0; this._endGame(); return; }

            /* ---- level progression ---- */
            const newLevel = clamp(1 + Math.floor(run.score / CONFIG.levelScoreStep), 1, CONFIG.maxLevel);
            if (newLevel > run.level) {
                run.level = newLevel;
                run.score += 1000;
                this._onLevelUp();
                this._updateHUD();
                return; // loop paused inside _onLevelUp
            }

            this._applyEnvironment();
            this._updateHUD();
        }

        /* ---------------- spawning ---------------- */
        _tickSpawns(dt, roadWidth) {
            const run = this.run;
            const lvl = run.level;
            this.spawnTimers.enemy -= dt;
            this.spawnTimers.obstacle -= dt;
            this.spawnTimers.collectible -= dt;

            if (this.spawnTimers.enemy <= 0) {
                this._spawnEnemy(roadWidth);
                this.spawnTimers.enemy = rand(1300, 2200) - lvl * 70;
                this.spawnTimers.enemy = Math.max(this.spawnTimers.enemy, 520);
            }
            if (this.spawnTimers.obstacle <= 0) {
                this._spawnObstacle(roadWidth);
                this.spawnTimers.obstacle = rand(2600, 4200) - lvl * 90;
                this.spawnTimers.obstacle = Math.max(this.spawnTimers.obstacle, 1200);
            }
            if (this.spawnTimers.collectible <= 0) {
                this._spawnCollectible(roadWidth);
                this.spawnTimers.collectible = rand(1800, 3000);
            }
        }

        _laneX(roadWidth, w) {
            const laneW = roadWidth / CONFIG.laneCount;
            const lane = randInt(0, CONFIG.laneCount - 1);
            return lane * laneW + laneW / 2 - w / 2;
        }

        _spawnEnemy(roadWidth) {
            const lvl = this.run.level;
            const roll = Math.random();
            let type = "car";
            if (roll < 0.10 + lvl * 0.01) type = "truck";
            else if (roll < 0.20 + lvl * 0.01) type = "bus";
            else if (roll < 0.34 + lvl * 0.015) type = "fast";
            else if (roll < 0.38) type = "police";

            const sizes = {
                car: { w: 44, h: 82, speed: 1.0 },
                fast: { w: 44, h: 80, speed: 1.32 },
                truck: { w: 56, h: 128, speed: 0.68 },
                bus: { w: 60, h: 140, speed: 0.8 },
                police: { w: 44, h: 82, speed: 1.05 },
            };
            const s = sizes[type];
            const el = document.createElement("div");
            el.className = `vehicle enemyCar type-${type}`;
            el.innerHTML = `<span class="headlight l"></span><span class="headlight r"></span>
                <span class="brakelight l"></span><span class="brakelight r"></span>`;
            el.style.width = s.w + "px";
            el.style.height = s.h + "px";
            applyImageFallback(el, type === "car" ? "car" : type);

            const x = this._laneX(roadWidth, s.w);
            const y = -s.h - rand(0, 120);
            el.style.left = x + "px";
            el.style.top = y + "px";
            this.gameArea.appendChild(el);

            this.entities.enemies.push({ el, x, y, w: s.w, h: s.h, type, speedMul: s.speed, passed: false, nearMissed: false });
        }

        _spawnObstacle(roadWidth) {
            const types = ["speedBreaker", "cone", "barrier", "oil"];
            const type = pick(types);
            const el = document.createElement("div");
            el.className = `obstacle ${type}`;

            let x, w, h;
            if (type === "speedBreaker") { w = roadWidth; h = 14; x = 0; }
            else if (type === "cone") { w = 22; h = 30; x = this._laneX(roadWidth, w); }
            else if (type === "barrier") { w = 70; h = 24; x = this._laneX(roadWidth, w); }
            else { w = 54; h = 34; x = this._laneX(roadWidth, w); }

            const y = -h - 40;
            el.style.left = x + "px";
            el.style.top = y + "px";
            this.gameArea.appendChild(el);
            this.entities.obstacles.push({ el, x, y, w, h, type });
        }

        _spawnCollectible(roadWidth) {
            const roll = Math.random();
            let type = "coin";
            if (roll < 0.10) type = "shieldPickup";
            else if (roll < 0.24) type = "nitroPickup";
            else if (roll < 0.36) type = "fuelPickup";

            const icons = { coin: "🪙", nitroPickup: "⚡", shieldPickup: "🛡️", fuelPickup: "⛽" };
            const el = document.createElement("div");
            el.className = `collectible ${type}`;
            el.textContent = icons[type];

            const w = 30;
            const x = this._laneX(roadWidth, w);
            const y = -40;
            el.style.left = x + "px";
            el.style.top = y + "px";
            this.gameArea.appendChild(el);
            this.entities.collectibles.push({ el, x, y, w, h: 30, type });
        }

        /* ---------------- movers + collision ---------------- */
        _overlap(ax, ay, aw, ah, bx, by, bw, bh) {
            return !(ax + aw < bx || ax > bx + bw || ay + ah < by || ay > by + bh);
        }

        _updateEnemies(scroll, roadHeight, roadWidth) {
            const p = this.player;
            const run = this.run;
            for (let i = this.entities.enemies.length - 1; i >= 0; i--) {
                const e = this.entities.enemies[i];
                e.y += scroll * e.speedMul;
                e.el.style.top = e.y + "px";

                // overtaken
                if (!e.passed && e.y > p.y + p.h) {
                    e.passed = true;
                    run.score += 100;
                    run.overtakes += 1;
                    this.toast("OVERTAKE +100", "overtake");
                    if (run.overtakes >= 10) this.unlockAchievement("overtake_10");
                }

                // near miss (adjacent lane, close vertical proximity, no collision)
                const verticallyClose = Math.abs((e.y + e.h / 2) - (p.y + p.h / 2)) < (e.h / 2 + p.h / 2);
                const horizGap = Math.min(Math.abs((e.x) - (p.x + p.w)), Math.abs((p.x) - (e.x + e.w)));
                if (!e.nearMissed && verticallyClose && horizGap >= 0 && horizGap < 16 &&
                    !this._overlap(p.x, p.y, p.w, p.h, e.x, e.y, e.w, e.h)) {
                    e.nearMissed = true;
                    run.score += 150;
                    run.nearMisses += 1;
                    this.toast("🔥 NEAR MISS +150", "near-miss");
                    if (run.nearMisses >= 5) this.unlockAchievement("near_miss_5");
                }

                // collision
                if (this._overlap(p.x, p.y, p.w, p.h, e.x, e.y, e.w, e.h)) {
                    this._handleHazardHit("vehicle");
                    e.y = roadHeight + 400; // remove after this frame
                }

                if (e.y > roadHeight + 40) {
                    e.el.remove();
                    this.entities.enemies.splice(i, 1);
                }
            }
        }

        _updateObstacles(scroll, roadHeight) {
            const p = this.player;
            for (let i = this.entities.obstacles.length - 1; i >= 0; i--) {
                const o = this.entities.obstacles[i];
                o.y += scroll;
                o.el.style.top = o.y + "px";

                if (this._overlap(p.x, p.y, p.w, p.h, o.x, o.y, o.w, o.h)) {
                    this._handleHazardHit(o.type);
                    o.y = roadHeight + 400;
                }
                if (o.y > roadHeight + 40) {
                    o.el.remove();
                    this.entities.obstacles.splice(i, 1);
                }
            }
        }

        _updateCollectibles(scroll, roadHeight) {
            const p = this.player;
            const run = this.run;
            for (let i = this.entities.collectibles.length - 1; i >= 0; i--) {
                const c = this.entities.collectibles[i];
                c.y += scroll;
                c.el.style.top = c.y + "px";

                if (this._overlap(p.x, p.y, p.w, p.h, c.x, c.y, c.w, c.h)) {
                    this._collectPickup(c.type);
                    c.el.remove();
                    this.entities.collectibles.splice(i, 1);
                    continue;
                }
                if (c.y > roadHeight + 40) {
                    c.el.remove();
                    this.entities.collectibles.splice(i, 1);
                }
            }
        }

        _collectPickup(type) {
            const run = this.run;
            if (type === "coin") {
                run.coins += 1;
                run.score += 50;
                this.save.stats.coinsAllTime += 1;
                this.sound.coin();
                if (this.save.stats.coinsAllTime >= 100) this.unlockAchievement("coins_100");
            } else if (type === "nitroPickup") {
                run.nitroCharges = Math.min(run.nitroCharges + 1, 3);
                this.sound.powerup();
                this.toast("⚡ NITRO READY", "overtake");
            } else if (type === "shieldPickup") {
                run.shield = true;
                this.player.el.classList.add("shield");
                if (!this.player.el.querySelector(".shieldRing")) {
                    const ring = document.createElement("div");
                    ring.className = "shieldRing";
                    this.player.el.appendChild(ring);
                }
                this.sound.powerup();
                this.toast("🛡️ SHIELD ON", "overtake");
            } else if (type === "fuelPickup") {
                run.fuel = Math.min(100, run.fuel + 35);
                this.sound.powerup();
                this.toast("⛽ +35% FUEL", "overtake");
            }
        }

        _handleHazardHit(kind) {
            const run = this.run;

            if (kind === "speedBreaker") {
                run.speedKmh = Math.max(CONFIG.minSpeedKmh, run.speedKmh * 0.45);
                run.speedBreakerLock = CONFIG.speedBreakerRecover;
                this.sound.speedbreaker();
                this._shake(true);
                return;
            }
            if (kind === "cone") {
                run.score = Math.max(0, run.score - 30);
                this.toast("CONE HIT -30", "penalty");
                this._shake(false);
                return;
            }
            if (kind === "oil") {
                run.oilSlideTimer = CONFIG.oilSlideDuration;
                run.oilDir = Math.random() < 0.5 ? -1 : 1;
                this.toast("OIL SLICK!", "penalty");
                return;
            }

            // "vehicle" or "barrier" => damaging hit
            if (run.shield) {
                run.shield = false;
                this.player.el.classList.remove("shield");
                this.player.el.querySelector(".shieldRing")?.remove();
                this.toast("SHIELD ABSORBED HIT", "overtake");
                this._shake(true);
                this.sound.powerup();
                return;
            }

            run.lives -= 1;
            this._crashFX();
            this.sound.crash();
            if (run.lives <= 0) { this._endGame(); }
        }

        _shake(strong) {
            this.carGameEl.classList.remove("shake");
            void this.carGameEl.offsetWidth;
            this.carGameEl.classList.add("shake");
        }

        _crashFX() {
            this._shake(true);
            const flash = document.createElement("div");
            flash.className = "impactFlash";
            this.gameArea.appendChild(flash);
            setTimeout(() => flash.remove(), 350);

            for (let i = 0; i < 4; i++) {
                const puff = document.createElement("div");
                puff.className = "smokePuff";
                puff.style.left = (this.player.x + rand(-6, this.player.w - 14)) + "px";
                puff.style.top = (this.player.y + rand(0, this.player.h - 20)) + "px";
                this.gameArea.appendChild(puff);
                setTimeout(() => puff.remove(), 650);
            }
        }

        _checkAchievement() {
            if (this.save.stats.nitroUses + this.run.nitroUses >= 10) this.unlockAchievement("nitro_master");
        }

        /* ---------------- environment ---------------- */
        _applyEnvironment() {
            const score = this.run.score;
            let env = "day";
            if (score > 7000) env = "night";
            else if (score > 3000) env = "sunset";
            if (env !== this.run.env) {
                this.run.env = env;
                this.carGameEl.classList.remove("env-sunset", "env-night");
                if (env !== "day") this.carGameEl.classList.add(`env-${env}`);
            }
        }

        _onLevelUp() {
            this._stopLoop();
            this.sound.levelup();
            document.getElementById("lcScore").textContent = Math.floor(this.run.score).toLocaleString();
            document.getElementById("lcCoins").textContent = this.run.coins;
            document.getElementById("lcDistance").textContent = this.run.distanceKm.toFixed(2);

            // random weather each level
            const weather = pick(["sunny", "sunny", "rain", "fog"]);
            this.carGameEl.classList.remove("weather-rain", "weather-fog");
            if (weather !== "sunny") this.carGameEl.classList.add(`weather-${weather}`);
            this.run.weather = weather;

            document.getElementById("levelValue").textContent = `LV ${this.run.level}`;
            const pill = document.getElementById("levelPill");
            pill.classList.add("bump");
            setTimeout(() => pill.classList.remove("bump"), 300);

            if (this.run.level >= CONFIG.maxLevel) {
                this.toast("🏁 MAX LEVEL — SURVIVE!", "achievement");
                this.state = GameState.PLAYING;
                this.lastTime = performance.now();
                this._loop(this.lastTime);
                return;
            }

            this.state = GameState.LEVEL_COMPLETE;
            this._show("levelComplete");
        }

        /* ---------------- HUD ---------------- */
        _updateHUD(force) {
            const run = this.run;
            document.getElementById("scoreValue").textContent = Math.floor(run.score).toLocaleString();
            document.getElementById("coinsValue").textContent = run.coins;
            document.getElementById("levelValue").textContent = `LV ${run.level}`;
            document.getElementById("livesValue").textContent = "❤️".repeat(Math.max(run.lives, 0)) || "💔";
            document.getElementById("speedValue").textContent = String(Math.round(run.speedKmh)).padStart(3, "0");

            const fuelFill = document.getElementById("fuelFill");
            fuelFill.style.width = clamp(run.fuel, 0, 100) + "%";
            fuelFill.classList.toggle("low", run.fuel < CONFIG.fuelWarn);

            const nitroPct = run.nitroActive
                ? clamp((run.nitroTimer / CONFIG.nitroDuration) * 100, 0, 100)
                : clamp(run.nitroCharges * 33.3, 0, 100);
            document.getElementById("nitroFill").style.width = nitroPct + "%";

            document.getElementById("bestInline").textContent = Math.max(this.save.bestScore, Math.floor(run.score)).toLocaleString();
        }

        /* ---------------- end of run ---------------- */
        _endGame() {
            this._stopLoop();
            this.state = GameState.GAME_OVER;
            const run = this.run;

            const isNewBest = run.score > this.save.bestScore;
            this.save.bestScore = Math.max(this.save.bestScore, Math.floor(run.score));
            this.save.bestLevel = Math.max(this.save.bestLevel, run.level);
            this.save.bestDistance = Math.max(this.save.bestDistance, run.distanceKm);
            this.save.stats.overtakes += run.overtakes;
            this.save.stats.nearMisses += run.nearMisses;
            this.save.stats.nitroUses += run.nitroUses;
            Storage.save(this.save);

            if (run.score >= 10000) this.unlockAchievement("score_10000");
            this.unlockAchievement("first_race");

            this.sound.gameover();

            document.getElementById("goScore").textContent = Math.floor(run.score).toLocaleString();
            document.getElementById("goCoins").textContent = run.coins;
            document.getElementById("goLevel").textContent = run.level;
            document.getElementById("goBest").textContent = this.save.bestScore.toLocaleString();
            document.getElementById("newBestBadge").classList.toggle("hide", !isNewBest);

            this._show("gameOver");
        }
    }

    /* ---------------- achievements catalogue ---------------- */
    const ACHIEVEMENTS = [
        { id: "first_race", name: "First Race", icon: "🏁" },
        { id: "overtake_10", name: "10 Cars Overtaken", icon: "🚗" },
        { id: "coins_100", name: "100 Coins", icon: "🪙" },
        { id: "score_10000", name: "10,000 Score", icon: "⭐" },
        { id: "near_miss_5", name: "5 Near Misses", icon: "🔥" },
        { id: "nitro_master", name: "Nitro Master", icon: "⚡" },
    ];

    /* ---------------- boot ---------------- */
    window.addEventListener("DOMContentLoaded", () => {
        window.__highwayRush = new Game();
    });
})();