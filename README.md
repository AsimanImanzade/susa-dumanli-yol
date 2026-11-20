# Şuşa: Dumanlı Yol (The Foggy Path)

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black) ![Three.js](https://img.shields.io/badge/Three.js-000000?style=flat-square&logo=threedotjs&logoColor=white) ![WebGL](https://img.shields.io/badge/WebGL-990000?style=flat-square&logo=webgl&logoColor=white) ![Web Audio](https://img.shields.io/badge/Web_Audio-4A4A55?style=flat-square) ![Node test](https://img.shields.io/badge/tests-86_passing-2E7D32?style=flat-square&logo=nodedotjs&logoColor=white)

A first-person stealth-action shooter that runs in the browser. One campaign mission in four acts, written in plain JavaScript on Three.js with no game engine and no bundler.

**[Play it here](https://susa-dumanli-yol.higgsfield.app)** (desktop, keyboard and mouse; Azerbaijani and English)

The mission is a work of fiction inspired by the battle for Shusha in November 2020: the forest approach, the cliff climb, the streets of Şuşa, and the final push to raise the flag. Enemies are armed, uniformed soldiers only. There are no civilians (the city is presented as evacuated), and landmarks such as the mosque are solid scenery that nothing ever fights in or around.

## At a glance

| | |
|---|---|
| Code | About 21,800 lines across 43 ES modules and 4 act files |
| Mission | 4 acts, each with its own sectors, patrols, checkpoints and objectives |
| Enemy AI | State machine (patrol, suspicious, searching, combat, stunned) with sight, hearing, radio check-ins and squad call-outs |
| Simulation | Hitscan and projectile ballistics, wood penetration, suppressor wear, bleeding and armour, a tank and artillery, enterable houses with doors |
| Art and sound | Every model, texture, sound effect and music layer is generated in code. No downloaded art |
| Tests | 86 unit tests on the pure rules, all passing |

## How it works

**Detection.** Each enemy has a meter from 0 to 1, drawn as an eye above his head. While you are inside his view cone with a clear sight line it fills at

`rate = base × difficulty × alertness × visibility × distance × cone`

where visibility = stance × movement × light × foliage. Fog and darkness shorten how far he can see. At 0.34 he turns suspicious and walks over; at 1.0 you are spotted. Out of sight, the meter drains (`stealth.js`).

**Noise.** Every audible action emits a noise event with a radius: footsteps by surface, stance and speed, shots, impacts, explosions, falling bodies, thrown stones. Walls cut the radius to 60%. Quiet noises make soldiers suspicious, loud ones start a search, and a distant shot gives only a rough direction (`noise.js`, `ai.js`).

**Enemy states.** Patrol → Suspicious → Searching (goes to your last known position and calls teammates) → Combat (takes cover, flanks on Hard, suppresses, throws grenades) → Searching again once you break line of sight. The transition table is a pure function in `ai-fsm.js`, so it is unit-tested on its own. Soldiers steer with acceleration and braking on a navigation grid and use directional walk and run gaits with planted feet.

**Bodies and radio.** A body an enemy sees puts the whole sector on alert, so you drag bodies into bushes or dumpsters. Radio operators report on a timer; if one is dead when his report is due, his sector goes on alert.

**Weapons.** The pistol and the AKM are hitscan with range falloff, per-weapon recoil patterns and penetration through thin wood. The SVD fires a real projectile with drop and travel time and has scope sway. A head hit from any firearm kills. Suppressors wear out shot by shot, get louder as they wear and are specific to each weapon.

**Vehicles.** A tank patrols the market square as a moving solid: its crew see with the soldiers' detection model through the driver's and the gunner's arcs, its engine masks your footsteps, and it shells your hiding place if you go to ground after being seen. C4 rides the moving hull, and only a charge on the engine deck, rear plate or fuel drums destroys it. The rules are in `vehicle-rules.js`.

**Houses.** Two- and three-storey townhouses have stairs, furniture, dark and lit rooms, and hinged doors that creak, block sight and are saved with checkpoints. The floor plans and door rules are in `interior-rules.js`.

**Rendering.** PBR textures with normal and roughness maps drawn on canvases at start-up, automatic quality with dynamic resolution, MSAA and stable shadows, AgX tone mapping and sky-based lighting. Sounds and the three music layers are synthesised with Web Audio.

**Saves.** Checkpoints save position, health, loadout, wrecks and door states to the browser when nobody is fighting you.

## Controls

All keys can be rebound in Settings.

| Action | Key | Action | Key |
|---|---|---|---|
| Move | W A S D | Fire / aim | Left / right mouse |
| Jump, vault | Space | Reload | R |
| Sprint, hold breath (scoped) | Shift | Pistol / primary 1 / primary 2 | 1 / 2 / 3 |
| Crouch / prone | C / Z | Suppressor on/off | X |
| Lean | Q / E | Knife | V |
| Interact, takedown, drag body | F | Throw (hold for arc) | G |
| C4: tap to place, hold to detonate | T | Medkit / bandage | H / J |
| Night vision | N | Equipment wheel (hold) | Tab |
| Map | M | Pause | Esc |

## Difficulty

| | Easy | Normal | Hard |
|---|---|---|---|
| Detection speed | ×0.6 | ×1.0 | ×1.6 |
| Enemy accuracy / damage | 0.50 / ×0.6 | 0.72 / ×1.0 | 0.90 / ×1.45 |
| Suppressor life (pistol) | ~66 shots | 40 shots | 25 shots |
| Search after alert | 16 s | 28 s | 48 s, with flanking |

Every number in the game lives in `app/public/js/config.js`.

## Run it

```bash
python3 tools/serve.py
```

Then open http://localhost:8765. The game runs fully in the browser and saves locally. `?debug=1` shows FPS and draw calls.

Tests (Node 22 or later, no install needed):

```bash
cd app && npm run test:unit
```

## Files

| Path | Purpose |
|---|---|
| `app/public/index.html`, `client.js` | Entry point |
| `app/public/js/` | One module per system: player, weapons, ballistics, equipment, ai, ai-fsm, stealth, noise, physics, nav, vehicles, interiors, hud, audio, render, textures, models, save, loc (all strings), config (all numbers) |
| `app/public/js/levels/` | The four acts |
| `app/public/dev/` | Viewers for soldiers, weapons, vehicles, houses and scenery |
| `app/public/vendor/` | Three.js (MIT) |
| `app/src/logic.js` | Mission record and validated end-of-mission score kept by the server |
| `app/tests-node/` | Unit tests (`node --test`) |
| `tools/serve.py` | Local static server |

---

By [Asiman Imanzade](https://asiman-imanzade.pages.dev). More projects on [my portfolio](https://asiman-imanzade.pages.dev).
