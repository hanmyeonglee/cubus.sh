(() => {
  'use strict';

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: false });
  const terminalLaunch = document.getElementById('terminal-launch');
  const bulkhead = document.getElementById('bulkhead');
  const modeReadout = document.getElementById('mode');
  const hintReadout = document.getElementById('hint');

  const TAU = Math.PI * 2;
  const CAMERA_Z = 7.8;
  const CAMERA_FOCAL = 6.7;
  const MINI_GRID_HALF = .34 * .85;
  const RETICLE_SIZE = 96;
  const FACE_ARROW_GAP = .26;
  const FACE_ARROW_REACH = .70;
  const EDGE_COLOR = '#f4ffff';
  const VECTOR_COLOR = '#51f7d1';
  const SIGNAL_COLOR = '#00ff66';
  const FACE_COLOR = '#07121a';
  const GLITCH_CYAN = '#00f0ff';
  const GLITCH_MAGENTA = '#ff2bb5';
  const RETICLE_COLOR = '#00f0ff';
  const FONT_STACK = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

  const navItems = [
    { label: 'ABOUT',    href: '#about' },
    { label: '???',      href: '#undefined' },
    { label: '???',      href: '#undefined' },
    { label: '???',      href: '#undefined' },
    { label: '???',      href: '#undefined' },
    { label: '???',      href: '#undefined' },
    { label: '???',      href: '#undefined' },
    { label: '???',      href: '#undefined' }
  ];

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOutCubic = (t) => {
    t = clamp(t, 0, 1);
    return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const randomSigned = (min, max) => randomBetween(min, max) * (Math.random() < .5 ? -1 : 1);

  const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
  const add = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
  const scaleVec = (a, scalar) => vec(a.x * scalar, a.y * scalar, a.z * scalar);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const length = (a) => Math.sqrt(dot(a, a));
  const normalize = (a) => {
    const len = length(a) || 1;
    return scaleVec(a, 1 / len);
  };
  const cloneVec = (a) => vec(a.x, a.y, a.z);

  function createRotationCache(rotation) {
    return {
      cosX: Math.cos(rotation.x),
      sinX: Math.sin(rotation.x),
      cosY: Math.cos(rotation.y),
      sinY: Math.sin(rotation.y),
      cosZ: Math.cos(rotation.z),
      sinZ: Math.sin(rotation.z)
    };
  }

  function rotatePointCached(point, rotation) {
    let { x, y, z } = point;

    const rotatedX = x * rotation.cosZ - y * rotation.sinZ;
    const rotatedY = x * rotation.sinZ + y * rotation.cosZ;
    x = rotatedX;
    y = rotatedY;

    const yawedX = x * rotation.cosY + z * rotation.sinY;
    const yawedZ = -x * rotation.sinY + z * rotation.cosY;
    x = yawedX;
    z = yawedZ;

    const pitchedY = y * rotation.cosX - z * rotation.sinX;
    const pitchedZ = y * rotation.sinX + z * rotation.cosX;
    y = pitchedY;
    z = pitchedZ;

    return vec(x, y, z);
  }

  function hashNoise(seed) {
    const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return (value - Math.floor(value)) * 2 - 1;
  }

  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    centerX: window.innerWidth / 2,
    centerY: window.innerHeight / 2,
    scale: Math.min(window.innerWidth, window.innerHeight) * .30,
    stars: []
  };

  const backgroundCache = {
    canvas: null,
    context: null,
    width: 0,
    height: 0,
    dpr: 0
  };

  function rebuildStars() {
    viewport.stars = [];
    let seed = 911;
    const count = Math.round(clamp(viewport.width * viewport.height / 16500, 36, 100));
    for (let i = 0; i < count; i += 1) {
      seed = (seed * 9301 + 49297) % 233280;
      const x = seed / 233280;
      seed = (seed * 9301 + 49297) % 233280;
      const y = seed / 233280;
      seed = (seed * 9301 + 49297) % 233280;
      const radius = .25 + (seed / 233280) * 1.1;
      seed = (seed * 9301 + 49297) % 233280;
      const alpha = .12 + (seed / 233280) * .34;
      seed = (seed * 9301 + 49297) % 233280;
      const phase = (seed / 233280) * TAU;
      viewport.stars.push({ x, y, radius, alpha, phase });
    }
  }

  function resizeCanvas() {
    viewport.width = window.innerWidth;
    viewport.height = window.innerHeight;
    viewport.dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewport.centerX = viewport.width / 2;
    viewport.centerY = viewport.height / 2;
    viewport.scale = Math.min(viewport.width, viewport.height) * .30;
    canvas.width = Math.round(viewport.width * viewport.dpr);
    canvas.height = Math.round(viewport.height * viewport.dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    rebuildStars();
    backgroundCache.width = 0;
    backgroundCache.height = 0;
    backgroundCache.dpr = 0;
    rebuildBackgroundCache();
    if (app.minis.length) updateGridTargets();
  }

  function worldToScreen(point) {
    const depth = Math.max(.8, CAMERA_Z - point.z);
    const perspective = CAMERA_FOCAL / depth;
    return {
      x: viewport.centerX + point.x * viewport.scale * perspective,
      y: viewport.centerY - point.y * viewport.scale * perspective,
      depth
    };
  }

  function screenToWorld(x, y, z = 0) {
    const depth = Math.max(.8, CAMERA_Z - z);
    const perspective = CAMERA_FOCAL / depth;
    const unit = viewport.scale * perspective;
    return vec((x - viewport.centerX) / unit, -(y - viewport.centerY) / unit, z);
  }

  function drawStaticBackground(target) {
    const w = viewport.width;
    const h = viewport.height;
    target.fillStyle = '#05050e';
    target.fillRect(0, 0, w, h);

    const cyanGlow = target.createRadialGradient(
      viewport.centerX - w * .22,
      viewport.centerY - h * .2,
      0,
      viewport.centerX - w * .22,
      viewport.centerY - h * .2,
      Math.max(w, h) * .66
    );
    cyanGlow.addColorStop(0, 'rgba(0, 240, 255, .13)');
    cyanGlow.addColorStop(.34, 'rgba(0, 143, 190, .05)');
    cyanGlow.addColorStop(1, 'rgba(0, 20, 44, 0)');
    target.fillStyle = cyanGlow;
    target.fillRect(0, 0, w, h);

    const purpleGlow = target.createRadialGradient(
      viewport.centerX + w * .24,
      viewport.centerY + h * .2,
      0,
      viewport.centerX + w * .24,
      viewport.centerY + h * .2,
      Math.max(w, h) * .7
    );
    purpleGlow.addColorStop(0, 'rgba(189, 0, 255, .12)');
    purpleGlow.addColorStop(.38, 'rgba(121, 40, 202, .055)');
    purpleGlow.addColorStop(1, 'rgba(20, 0, 40, 0)');
    target.fillStyle = purpleGlow;
    target.fillRect(0, 0, w, h);

    const horizon = target.createLinearGradient(0, h * .33, 0, h);
    horizon.addColorStop(0, 'rgba(0, 240, 255, 0)');
    horizon.addColorStop(.54, 'rgba(121, 40, 202, .012)');
    horizon.addColorStop(1, 'rgba(0, 240, 255, .028)');
    target.fillStyle = horizon;
    target.fillRect(0, 0, w, h);

    target.save();
    target.strokeStyle = 'rgba(0, 240, 255, .045)';
    target.lineWidth = 1;
    target.beginPath();
    target.arc(viewport.centerX, viewport.centerY, Math.min(w, h) * .27, 0, TAU);
    target.stroke();
    target.strokeStyle = 'rgba(189, 0, 255, .035)';
    target.beginPath();
    target.arc(viewport.centerX, viewport.centerY, Math.min(w, h) * .36, 0, TAU);
    target.stroke();
    target.restore();
  }

  function rebuildBackgroundCache() {
    const width = canvas.width;
    const height = canvas.height;
    if (backgroundCache.canvas &&
        backgroundCache.width === width &&
        backgroundCache.height === height &&
        backgroundCache.dpr === viewport.dpr) {
      return;
    }

    if (!backgroundCache.canvas) backgroundCache.canvas = document.createElement('canvas');
    backgroundCache.canvas.width = width;
    backgroundCache.canvas.height = height;
    backgroundCache.context = backgroundCache.canvas.getContext('2d', { alpha: false });
    backgroundCache.context.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    drawStaticBackground(backgroundCache.context);
    backgroundCache.width = width;
    backgroundCache.height = height;
    backgroundCache.dpr = viewport.dpr;
  }

  function drawBackground(time) {
    const w = viewport.width;
    const h = viewport.height;
    rebuildBackgroundCache();

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.drawImage(backgroundCache.canvas, 0, 0, w, h);
    ctx.restore();

    ctx.save();
    for (const star of viewport.stars) {
      const shimmer = .74 + Math.sin(time * .00045 + star.phase) * .26;
      ctx.globalAlpha = star.alpha * shimmer;
      ctx.fillStyle = star.radius > 1 ? '#c0faff' : '#ffffff';
      ctx.beginPath();
      ctx.arc(star.x * w, star.y * h, star.radius, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  const cubeVertices = [
    vec(-1, -1, -1), vec(1, -1, -1), vec(1, 1, -1), vec(-1, 1, -1),
    vec(-1, -1, 1),  vec(1, -1, 1),  vec(1, 1, 1),  vec(-1, 1, 1)
  ];

  const cubeEdges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7]
  ];

  const faceDefs = [
    {
      id: 'bottom',
      normal: vec(0, -1, 0),
      map: (u, v) => vec(u, -1, v),
      vertices: [0, 1, 5, 4]
    },
    {
      id: 'top',
      normal: vec(0, 1, 0),
      map: (u, v) => vec(u, 1, v),
      vertices: [3, 7, 6, 2]
    },
    {
      id: 'front',
      normal: vec(0, 0, 1),
      map: (u, v) => vec(u, v, 1),
      vertices: [4, 5, 6, 7]
    },
    {
      id: 'back',
      normal: vec(0, 0, -1),
      map: (u, v) => vec(-u, v, -1),
      vertices: [1, 0, 3, 2]
    },
    {
      id: 'right',
      normal: vec(1, 0, 0),
      map: (u, v) => vec(1, v, -u),
      vertices: [1, 5, 6, 2]
    },
    {
      id: 'left',
      normal: vec(-1, 0, 0),
      map: (u, v) => vec(-1, v, u),
      vertices: [0, 3, 7, 4]
    }
  ];

  const sideFaceChevrons = Array.from({ length: 3 }, (_, row) => {
    const v = -.55 + row * .55;
    return [[-.28, v - .13], [0, v + .13], [.28, v - .13]];
  });

  const faceTextureChevrons = {
    bottom: [
      [[-.20, FACE_ARROW_GAP], [0, FACE_ARROW_REACH], [.20, FACE_ARROW_GAP]],
      [[-.20, -FACE_ARROW_GAP], [0, -FACE_ARROW_REACH], [.20, -FACE_ARROW_GAP]],
      [[FACE_ARROW_GAP, -.20], [FACE_ARROW_REACH, 0], [FACE_ARROW_GAP, .20]],
      [[-FACE_ARROW_GAP, -.20], [-FACE_ARROW_REACH, 0], [-FACE_ARROW_GAP, .20]]
    ],
    top: [
      [[-.20, .66], [0, FACE_ARROW_GAP], [.20, .66]],
      [[-.20, -.66], [0, -FACE_ARROW_GAP], [.20, -.66]],
      [[-.66, -.20], [-FACE_ARROW_GAP, 0], [-.66, .20]],
      [[.66, -.20], [FACE_ARROW_GAP, 0], [.66, .20]]
    ]
  };

  function buildFaceTextureGeometry(face) {
    const chevrons = faceTextureChevrons[face.id] || sideFaceChevrons;
    const points = [];
    const pointIndexes = new Map();
    const segments = [];
    const pointIndex = ([u, v]) => {
      const point = face.map(u, v);
      const key = `${point.x}:${point.y}:${point.z}`;
      if (!pointIndexes.has(key)) {
        pointIndexes.set(key, points.length);
        points.push(point);
      }
      return pointIndexes.get(key);
    };

    for (const [start, tip, end] of chevrons) {
      const startIndex = pointIndex(start);
      const tipIndex = pointIndex(tip);
      const endIndex = pointIndex(end);
      segments.push([startIndex, tipIndex], [tipIndex, endIndex]);
    }
    return { points, segments };
  }

  for (const face of faceDefs) face.textureGeometry = buildFaceTextureGeometry(face);

  function transformedVertices(cube, options, rotation) {
    const vertexJitter = options.vertexJitter || 0;
    const seed = options.seed || 0;
    return cubeVertices.map((vertex, index) => {
      let local = scaleVec(vertex, cube.half);
      if (vertexJitter) {
        local = add(local, vec(
          hashNoise(seed + index * 17.11) * vertexJitter,
          hashNoise(seed + index * 29.37 + 11) * vertexJitter,
          hashNoise(seed + index * 43.73 + 23) * vertexJitter
        ));
      }
      return add(cube.position, rotatePointCached(local, rotation));
    });
  }

  function makeProjectedPoint(cube, localPoint, options, rotation) {
    const world = add(cube.position, rotatePointCached(scaleVec(localPoint, cube.half), rotation));
    const projected = worldToScreen(world);
    projected.x += options.offsetX || 0;
    projected.y += options.offsetY || 0;
    projected.world = world;
    return projected;
  }

  function strokeProjectedPath(points, color, width, alpha = 1, glow = 0, closed = false) {
    if (!points.length) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    if (closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawFaceTexture(cube, face, options, facing, rotation) {
    const visibility = clamp(.38 + facing * .62, .12, 1);
    const alpha = (options.textureAlpha ?? 1) * visibility;
    const geometry = face.textureGeometry;
    const projected = geometry.points.map((point) => makeProjectedPoint(cube, point, options, rotation));

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = VECTOR_COLOR;
    ctx.lineWidth = Math.max(.72, cube.half * 2.15);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = VECTOR_COLOR;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    for (const [from, to] of geometry.segments) {
      ctx.moveTo(projected[from].x, projected[from].y);
      ctx.lineTo(projected[to].x, projected[to].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function renderCube(cube, options = {}) {
    const settings = {
      seed: 0,
      vertexJitter: 0,
      offsetX: 0,
      offsetY: 0,
      wireOnly: false,
      textureAlpha: 1,
      edgeColor: EDGE_COLOR,
      edgeAlpha: 1,
      edgeGlow: 1,
      faceOutlineColor: VECTOR_COLOR,
      faceOutlineAlpha: .28,
      faceOutlineScale: 1,
      faceGlow: 0,
      fillAlpha: 1,
      ...options
    };

    const rotation = createRotationCache(cube.rotation);
    const worldVertices = transformedVertices(cube, settings, rotation);
    const projectedVertices = worldVertices.map((world) => {
      const projected = worldToScreen(world);
      projected.x += settings.offsetX;
      projected.y += settings.offsetY;
      projected.world = world;
      return projected;
    });

    const cameraPosition = vec(0, 0, CAMERA_Z);
    const projectedFaces = faceDefs.map((face) => {
      const normal = rotatePointCached(face.normal, rotation);
      const center = add(cube.position, scaleVec(normal, cube.half));
      const toCamera = normalize(add(cameraPosition, scaleVec(center, -1)));
      const facing = dot(normal, toCamera);
      const points = face.vertices.map((index) => projectedVertices[index]);
      return {
        face,
        points,
        facing,
        depth: points.reduce((sum, point) => sum + point.world.z, 0) / points.length
      };
    });

    projectedFaces.sort((a, b) => a.depth - b.depth);

    if (!settings.wireOnly) {
      ctx.save();
      ctx.fillStyle = FACE_COLOR;
      for (const item of projectedFaces) {
        const faceAlpha = settings.fillAlpha * clamp(.13 + Math.max(0, item.facing) * .22, .10, .36);
        ctx.globalAlpha = faceAlpha;
        ctx.beginPath();
        ctx.moveTo(item.points[0].x, item.points[0].y);
        for (let i = 1; i < item.points.length; i += 1) ctx.lineTo(item.points[i].x, item.points[i].y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      for (const item of projectedFaces) {
        const localAlpha = settings.textureAlpha * clamp(.24 + Math.max(0, item.facing) * .76, .2, 1);
        drawFaceTexture(cube, item.face, settings, item.facing, rotation);

        strokeProjectedPath(
          item.points,
          settings.faceOutlineColor,
          Math.max(.45, cube.half * .48) * settings.faceOutlineScale,
          localAlpha * settings.faceOutlineAlpha,
          settings.faceGlow,
          true
        );
      }
    }

    ctx.save();
    ctx.globalAlpha = settings.edgeAlpha;
    ctx.strokeStyle = settings.edgeColor;
    ctx.lineWidth = Math.max(.8, cube.half * 1.35);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = settings.edgeColor;
    ctx.shadowBlur = (settings.edgeColor === EDGE_COLOR ? Math.max(5, cube.half * 5.2) : Math.max(3, cube.half * 3)) * settings.edgeGlow;
    ctx.beginPath();
    for (const [from, to] of cubeEdges) {
      ctx.moveTo(projectedVertices[from].x, projectedVertices[from].y);
      ctx.lineTo(projectedVertices[to].x, projectedVertices[to].y);
    }
    ctx.stroke();
    ctx.restore();

    return {
      vertices: projectedVertices,
      faces: projectedFaces,
      bounds: getBounds(projectedVertices)
    };
  }

  function getBounds(points) {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const point of points) {
      if (point.x < left) left = point.x;
      if (point.x > right) right = point.x;
      if (point.y < top) top = point.y;
      if (point.y > bottom) bottom = point.y;
    }
    return { left, right, top, bottom };
  }

  const glitch = {
    enabled: true,
    active: false,
    startedAt: 0,
    duration: 0,
    seed: 0,
    nextAt: randomBetween(4000, 8000),
    intensity: 0,
    audioPlayed: false
  };

  const STATIC_GLITCH_SOURCES = [
    'static/audio/glitch01.mp3',
    'static/audio/glitch02.mp3',
    'static/audio/glitch03.mp3',
    'static/audio/glitch04.mp3',
    'static/audio/glitch05.mp3'
  ];
  const STATIC_GLITCH_VOLUME = .5;
  const staticGlitchAudio = {
    clips: [],
    preloaded: false,
    unlocked: false,
    previousIndex: -1,
    warnedAboutAutoplay: false
  };

  // Asset paths are intentionally empty until the final sound design is supplied.
  // They can be populated without changing the sequence through window.cubusIntroAudio.configure().
  const INTRO_AUDIO_CUES = {
    lockClick: { source: '', at: 0, volume: .82 },
    neonFlare: { source: '', at: 120, volume: .58 },
    hydraulicOpen: { source: '', at: 400, volume: .74 }
  };
  const introAudio = {
    clips: new Map(),
    unlocked: false,
    warnedAboutAutoplay: false
  };

  function preloadIntroAudioCue(name) {
    const cue = INTRO_AUDIO_CUES[name];
    if (!cue || !cue.source || typeof window.Audio !== 'function') return null;
    const existing = introAudio.clips.get(name);
    if (existing && existing.src === new URL(cue.source, window.location.href).href) return existing;

    const clip = new window.Audio();
    clip.preload = 'auto';
    clip.src = cue.source;
    clip.volume = cue.volume;
    clip.playsInline = true;
    clip.load();
    introAudio.clips.set(name, clip);
    return clip;
  }

  function unlockIntroAudio() {
    introAudio.unlocked = true;
    for (const name of Object.keys(INTRO_AUDIO_CUES)) preloadIntroAudioCue(name);
  }

  function playIntroCue(name) {
    const cue = INTRO_AUDIO_CUES[name];
    const clip = preloadIntroAudioCue(name);
    if (!cue || !clip) return false;
    if (!introAudio.unlocked) {
      if (!introAudio.warnedAboutAutoplay) {
        console.warn('[CUBUS AUDIO] Intro cue playback is waiting for a user interaction.');
        introAudio.warnedAboutAutoplay = true;
      }
      return false;
    }

    try {
      clip.pause();
      clip.currentTime = 0;
      clip.volume = cue.volume;
      const playback = clip.play();
      if (playback && typeof playback.catch === 'function') {
        playback.catch((error) => {
          console.warn('[CUBUS AUDIO] Intro cue playback was rejected:', { name, source: cue.source, error });
        });
      }
      return true;
    } catch (error) {
      console.warn('[CUBUS AUDIO] Intro cue playback failed:', { name, source: cue.source, error });
      return false;
    }
  }

  function configureIntroAudio(sources = {}) {
    for (const [name, source] of Object.entries(sources)) {
      if (!INTRO_AUDIO_CUES[name] || typeof source !== 'string') continue;
      INTRO_AUDIO_CUES[name].source = source;
      introAudio.clips.delete(name);
      preloadIntroAudioCue(name);
    }
  }

  window.cubusIntroAudio = Object.freeze({
    configure: configureIntroAudio,
    cues: INTRO_AUDIO_CUES
  });

  function preloadStaticGlitchAudio() {
    if (staticGlitchAudio.preloaded) return staticGlitchAudio.clips;
    if (typeof window.Audio !== 'function') {
      console.warn('[CUBUS AUDIO] HTMLAudioElement is unavailable; static glitch audio cannot play.');
      return [];
    }

    staticGlitchAudio.clips = STATIC_GLITCH_SOURCES.map((sourcePath) => {
      const clip = new window.Audio();
      clip.preload = 'auto';
      clip.src = sourcePath;
      clip.volume = STATIC_GLITCH_VOLUME;
      clip.playsInline = true;
      clip.load();
      return clip;
    });
    staticGlitchAudio.preloaded = true;
    return staticGlitchAudio.clips;
  }

  function chooseStaticGlitchIndex() {
    const count = STATIC_GLITCH_SOURCES.length;
    if (count < 2) return 0;
    let index = Math.floor(Math.random() * count);
    if (index === staticGlitchAudio.previousIndex) {
      index = (index + 1 + Math.floor(Math.random() * (count - 1))) % count;
    }
    staticGlitchAudio.previousIndex = index;
    return index;
  }

  function unlockStaticGlitchAudio() {
    const clips = preloadStaticGlitchAudio();
    staticGlitchAudio.unlocked = clips.length === STATIC_GLITCH_SOURCES.length;

    if (staticGlitchAudio.unlocked && glitch.active && !glitch.audioPlayed) {
      glitch.audioPlayed = playRandomGlitchSound();
    }
    return staticGlitchAudio.unlocked;
  }

  function playRandomGlitchSound() {
    const clips = preloadStaticGlitchAudio();
    if (!staticGlitchAudio.unlocked || clips.length !== STATIC_GLITCH_SOURCES.length) {
      if (!staticGlitchAudio.warnedAboutAutoplay) {
        console.warn('[CUBUS AUDIO] Static glitch playback is waiting for a user interaction.');
        staticGlitchAudio.warnedAboutAutoplay = true;
      }
      return false;
    }

    const index = chooseStaticGlitchIndex();
    const clip = clips[index];
    try {

      clip.pause();
      clip.currentTime = 0;
      clip.volume = STATIC_GLITCH_VOLUME;
      const playback = clip.play();
      if (playback && typeof playback.catch === 'function') {
        playback.catch((error) => {
          console.warn('[CUBUS AUDIO] Static glitch playback was rejected:', {
            asset: STATIC_GLITCH_SOURCES[index],
            name: error && error.name,
            message: error && error.message
          });
        });
      }
      return true;
    } catch (error) {
      console.warn('[CUBUS AUDIO] Static glitch playback failed:', {
        asset: STATIC_GLITCH_SOURCES[index],
        name: error && error.name,
        message: error && error.message
      });
      return false;
    }
  }

  function startGlitch(time) {
    if (!glitch.enabled) return;
    glitch.active = true;
    glitch.startedAt = time;
    glitch.duration = randomBetween(100, 200);
    glitch.seed = Math.random() * 10000;
    glitch.intensity = randomBetween(.72, 1.18);
    glitch.nextAt = time + randomBetween(4000, 8000);
    glitch.audioPlayed = false;
    triggerMiniRotationBoost(time);
    glitch.audioPlayed = playRandomGlitchSound();
  }

  function updateGlitch(time) {
    if (!glitch.enabled) {
      glitch.active = false;
      glitch.intensity = 0;
      glitch.audioPlayed = false;
      return;
    }
    if (!glitch.active && time >= glitch.nextAt) startGlitch(time);
    if (glitch.active) {
      const elapsed = time - glitch.startedAt;
      if (elapsed >= glitch.duration) {
        glitch.active = false;
        glitch.intensity = 0;
        glitch.audioPlayed = false;
      } else {
        const envelope = Math.sin(Math.PI * elapsed / glitch.duration);
        glitch.intensity = Math.max(.1, envelope);
      }
    }
  }

  const app = {
    state: 'locked',
    interactionEnabled: false,
    hoveredIndex: -1,
    pointer: { x: -9999, y: -9999 },
    minis: [],
    lastTime: performance.now(),
  };

  const introSequence = {
    startedAt: 0,
    authDuration: 300,
    doorStartAt: 400,
    doorDuration: 800,
    completed: false,
    cuesPlayed: new Set()
  };
  let isBooted = false;

  function makeMiniCube(index, column, row, depth) {
    const velocityTarget = {
      x: randomSigned(.026, .062),
      y: randomSigned(.038, .082),
      z: randomSigned(.02, .052)
    };
    return {
      index,
      column,
      row,
      depth,
      label: navItems[index].label,
      href: navItems[index].href,
      targetPosition: vec(),
      position: vec(),
      half: MINI_GRID_HALF,
      rotation: {
        x: randomBetween(-.72, .72),
        y: randomBetween(-1.05, 1.05),
        z: randomBetween(-.44, .44)
      },
      velocity: { ...velocityTarget },
      velocityTarget,
      rotationBoost: null,
      hit: null,
      hovered: false
    };
  }

  function buildMinis() {
    app.minis = [];
    let index = 0;
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        app.minis.push(makeMiniCube(index, column, row, index % 2 ? -.03 : .03));
        index += 1;
      }
    }
  }

  function gridScreenAnchor(column, row) {
    const x = viewport.width * ((column + .5) / 4);
    const top = clamp(viewport.height * .335, 150, 260);
    const bottom = clamp(viewport.height * .685, 365, viewport.height - 120);
    const y = row === 0 ? top : Math.max(top + 112, bottom);
    return { x, y };
  }

  function updateGridTargets() {
    for (const mini of app.minis) {
      const anchor = gridScreenAnchor(mini.column, mini.row);
      mini.targetPosition = screenToWorld(anchor.x, anchor.y, mini.depth);
      mini.position = cloneVec(mini.targetPosition);
    }
  }

  function triggerMiniRotationBoost(time) {
    for (const mini of app.minis) {
      const burstVelocity = {
        x: randomSigned(.38, .82),
        y: randomSigned(.5, .98),
        z: randomSigned(.25, .64)
      };
      mini.velocity = { ...burstVelocity };
      mini.rotationBoost = {
        startedAt: time,
        duration: randomBetween(1050, 1650),
        burstVelocity
      };
    }
  }

  function fireIntroCue(name) {
    if (introSequence.cuesPlayed.has(name)) return;
    introSequence.cuesPlayed.add(name);
    playIntroCue(name);
  }

  function updateIntroSequence(time) {
    if (app.state !== 'unlocking' || introSequence.completed) return;
    const elapsed = time - introSequence.startedAt;

    if (elapsed >= INTRO_AUDIO_CUES.neonFlare.at) fireIntroCue('neonFlare');
    if (elapsed >= introSequence.authDuration) {
      terminalLaunch.classList.remove('is-authenticating');
      terminalLaunch.classList.add('is-releasing');
    }
    if (elapsed >= introSequence.doorStartAt) {
      bulkhead.classList.add('is-opening');
      app.interactionEnabled = true;
      canvas.classList.add('is-visible');
      fireIntroCue('hydraulicOpen');
    }
    if (elapsed < introSequence.doorStartAt + introSequence.doorDuration + 40) return;

    introSequence.completed = true;
    isBooted = true;
    app.state = 'grid';
    glitch.nextAt = time + randomBetween(4000, 8000);
    modeReadout.textContent = 'GRID ONLINE';
    hintReadout.textContent = 'SELECT A DIMENSION';
    document.body.classList.remove('booting');
    bulkhead.setAttribute('aria-hidden', 'true');
    bulkhead.hidden = true;
  }

  function beginBulkheadSequence(time) {
    if (isBooted || app.state !== 'locked') return;
    introSequence.startedAt = time;
    introSequence.completed = false;
    introSequence.cuesPlayed.clear();
    app.state = 'unlocking';
    terminalLaunch.classList.add('is-authenticating');
    terminalLaunch.setAttribute('aria-disabled', 'true');
    terminalLaunch.blur();
    bulkhead.classList.add('is-authenticating');
    bulkhead.setAttribute('aria-label', 'Security bulkhead unlocking');

    unlockStaticGlitchAudio();
    unlockIntroAudio();
    fireIntroCue('lockClick');
  }

  function updateMinis(dt, time) {
    for (const mini of app.minis) {
      const speed = app.hoveredIndex === mini.index ? 1.12 : 1;
      let targetVelocity = mini.velocityTarget;
      if (mini.rotationBoost) {
        const progress = clamp((time - mini.rotationBoost.startedAt) / mini.rotationBoost.duration, 0, 1);
        const decay = 1 - easeInOutCubic(progress);
        targetVelocity = {
          x: lerp(mini.velocityTarget.x, mini.rotationBoost.burstVelocity.x, decay),
          y: lerp(mini.velocityTarget.y, mini.rotationBoost.burstVelocity.y, decay),
          z: lerp(mini.velocityTarget.z, mini.rotationBoost.burstVelocity.z, decay)
        };
        if (progress >= 1) mini.rotationBoost = null;
      }
      const smoothing = 1 - Math.pow(.002, dt);
      mini.velocity.x = lerp(mini.velocity.x, targetVelocity.x, smoothing);
      mini.velocity.y = lerp(mini.velocity.y, targetVelocity.y, smoothing);
      mini.velocity.z = lerp(mini.velocity.z, targetVelocity.z, smoothing);
      mini.rotation.x += mini.velocity.x * dt * speed;
      mini.rotation.y += mini.velocity.y * dt * speed;
      mini.rotation.z += mini.velocity.z * dt * speed;
    }
  }

  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;
      const intersects = ((yi > point.y) !== (yj > point.y)) &&
        point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || .00001) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function pointInBounds(point, bounds, padding = 0) {
    return point.x >= bounds.left - padding && point.x <= bounds.right + padding &&
      point.y >= bounds.top - padding && point.y <= bounds.bottom + padding;
  }

  function cubeIsHit(point, hit, padding = 0) {
    if (!hit || !pointInBounds(point, hit.bounds, padding)) return false;
    return hit.faces.some((face) => pointInPolygon(point, face.points));
  }

  function hitTest(point) {
    if (!app.interactionEnabled) return -1;
    for (let i = app.minis.length - 1; i >= 0; i -= 1) {
      if (cubeIsHit(point, app.minis[i].hit, 6)) return i;
    }
    return -1;
  }

  function updateHover() {
    const hit = hitTest(app.pointer);
    const next = typeof hit === 'number' ? hit : -1;
    app.hoveredIndex = next;
    for (const mini of app.minis) mini.hovered = mini.index === next;
    canvas.style.cursor = next >= 0 ? 'pointer' : 'default';
  }

  function drawCubeLabel(mini) {
    if (!mini.hit) return;
    const centerX = (mini.hit.bounds.left + mini.hit.bounds.right) / 2;
    const bottom = mini.hit.bounds.bottom;
    const hover = mini.hovered;
    const unit = clamp(Math.min(viewport.width, viewport.height) / 600, .62, 1.18);
    const labelSize = clamp(11 * unit, 8, 13);
    const urlSize = clamp(8 * unit, 7, 10);
    const labelY = bottom + 23 * unit;
    const urlY = labelY + 13 * unit;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${labelSize}px ${FONT_STACK}`;
    ctx.fillStyle = hover ? '#ffffff' : 'rgba(227, 255, 246, .78)';
    ctx.shadowColor = hover ? SIGNAL_COLOR : 'rgba(0, 255, 102, .28)';
    ctx.shadowBlur = hover ? 12 : 5;
    ctx.fillText(mini.label, centerX, labelY);
    ctx.shadowBlur = 0;
    ctx.font = `${urlSize}px ${FONT_STACK}`;
    ctx.fillStyle = hover ? 'rgba(0, 255, 102, .95)' : 'rgba(0, 255, 102, .53)';
    ctx.fillText(mini.href, centerX, urlY);

    if (hover) {
      ctx.strokeStyle = 'rgba(0, 255, 102, .48)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(centerX - Math.min(33, viewport.width * .06), urlY + 9);
      ctx.lineTo(centerX + Math.min(33, viewport.width * .06), urlY + 9);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTargetingBrackets(mini) {
    if (!mini.hit) return;
    const center = worldToScreen(mini.position);
    const half = RETICLE_SIZE / 2;
    const left = center.x - half;
    const right = center.x + half;
    const top = center.y - half;
    const bottom = center.y + half;
    const arm = 15;
    const centerX = center.x;
    const centerY = center.y;

    ctx.save();
    ctx.strokeStyle = RETICLE_COLOR;
    ctx.shadowColor = RETICLE_COLOR;
    ctx.shadowBlur = 12;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'square';

    const bracket = (x, y, horizontal, vertical) => {
      ctx.beginPath();
      ctx.moveTo(x, y + vertical * arm);
      ctx.lineTo(x, y);
      ctx.lineTo(x + horizontal * arm, y);
      ctx.stroke();
    };

    bracket(left, top, 1, 1);
    bracket(right, top, -1, 1);
    bracket(left, bottom, 1, -1);
    bracket(right, bottom, -1, -1);

    ctx.globalAlpha = .58;
    ctx.lineWidth = .8;
    ctx.beginPath();
    ctx.moveTo(centerX - 3, top - 4);
    ctx.lineTo(centerX + 3, top - 4);
    ctx.moveTo(centerX - 3, bottom + 4);
    ctx.lineTo(centerX + 3, bottom + 4);
    ctx.moveTo(left - 4, centerY - 3);
    ctx.lineTo(left - 4, centerY + 3);
    ctx.moveTo(right + 4, centerY - 3);
    ctx.lineTo(right + 4, centerY + 3);
    ctx.moveTo(centerX - 4, centerY);
    ctx.lineTo(centerX + 4, centerY);
    ctx.moveTo(centerX, centerY - 4);
    ctx.lineTo(centerX, centerY + 4);
    ctx.stroke();
    ctx.globalAlpha = .9;
    ctx.fillStyle = RETICLE_COLOR;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 1.45, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function renderMini(mini, time) {
    const hovered = mini.hovered;
    const glitchActive = glitch.active;
    const frameSeed = glitch.seed + Math.floor(time / 16.6667);
    const renderTarget = hovered ? { ...mini, half: mini.half * 1.09 } : mini;
    if (glitchActive) {
      renderCube(renderTarget, {
        wireOnly: true,
        edgeColor: GLITCH_MAGENTA,
        edgeAlpha: .84 * glitch.intensity,
        offsetX: -4.5 * glitch.intensity,
        offsetY: .8 * glitch.intensity,
        vertexJitter: .075 * glitch.intensity,
        seed: frameSeed + mini.index * 9
      });
      renderCube(renderTarget, {
        wireOnly: true,
        edgeColor: GLITCH_CYAN,
        edgeAlpha: .88 * glitch.intensity,
        offsetX: 4.5 * glitch.intensity,
        offsetY: -.8 * glitch.intensity,
        vertexJitter: .07 * glitch.intensity,
        seed: frameSeed + mini.index * 11 + 29
      });
    }
    mini.hit = renderCube(renderTarget, {
      vertexJitter: glitchActive ? .06 * glitch.intensity : 0,
      seed: frameSeed + mini.index,
      edgeAlpha: hovered ? 1.35 : .92,
      edgeColor: hovered ? '#ffffff' : EDGE_COLOR,
      fillAlpha: hovered ? 1.16 : .88,
      textureAlpha: hovered ? 1.18 : .82
    });
    if (hovered) {
      drawTargetingBrackets(mini);
    }
  }

  function render(time) {
    drawBackground(time);
    if (app.state === 'grid') updateGlitch(time);

    for (const mini of app.minis) renderMini(mini, time);
    for (const mini of app.minis) drawCubeLabel(mini);

    if (app.interactionEnabled) updateHover();
  }

  function frame(time) {
    const elapsed = Math.min(42, time - app.lastTime);
    const dt = elapsed / 1000;
    app.lastTime = time;

    if (app.state === 'unlocking') updateIntroSequence(time);
    updateMinis(dt, time);
    render(time);
    requestAnimationFrame(frame);
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function unlockAllAudio() {
    unlockStaticGlitchAudio();
    unlockIntroAudio();
  }

  window.addEventListener('pointerdown', unlockAllAudio, { capture: true });
  window.addEventListener('touchstart', unlockAllAudio, { capture: true, passive: true });
  window.addEventListener('keydown', (event) => {
    unlockAllAudio();
    if (!isBooted && app.state === 'locked' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      beginBulkheadSequence(performance.now());
    }
  }, { capture: true });

  terminalLaunch.addEventListener('click', () => {
    beginBulkheadSequence(performance.now());
  });

  canvas.addEventListener('pointermove', (event) => {
    app.pointer = pointerPosition(event);
    updateHover();
  });

  canvas.addEventListener('pointerleave', () => {
    app.pointer = { x: -9999, y: -9999 };
    app.hoveredIndex = -1;
    for (const mini of app.minis) mini.hovered = false;
    canvas.style.cursor = 'default';
  });

  canvas.addEventListener('pointerdown', (event) => {
    unlockAllAudio();
    app.pointer = pointerPosition(event);
    const hit = hitTest(app.pointer);
    if (typeof hit === 'number') {
      const destination = app.minis[hit].href;
      window.location.assign(destination);
    }
  });

  canvas.addEventListener('keydown', (event) => {
    unlockAllAudio();
    if (event.key === 'Escape') canvas.blur();
  });

  window.addEventListener('resize', resizeCanvas, { passive: true });

  preloadStaticGlitchAudio();
  resizeCanvas();
  buildMinis();
  updateGridTargets();
  requestAnimationFrame(frame);
})();
