(() => {
  'use strict';

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: false });
  const terminalLaunch = document.getElementById('terminal-launch');
  const bootPrompt = document.getElementById('boot-prompt');
  const modeReadout = document.getElementById('mode');
  const hintReadout = document.getElementById('hint');

  const TAU = Math.PI * 2;
  const CAMERA_Z = 7.8;
  const CAMERA_FOCAL = 6.7;
  const MASTER_HALF = .8;
  const MINI_GRID_HALF = .34 * .85;
  const MINI_CLUSTER_HALF = MASTER_HALF * .5;
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
  const blendHexColor = (from, to, amount) => {
    const parse = (hex) => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    ];
    const a = parse(from);
    const b = parse(to);
    const t = clamp(amount, 0, 1);
    return `rgb(${Math.round(lerp(a[0], b[0], t))}, ${Math.round(lerp(a[1], b[1], t))}, ${Math.round(lerp(a[2], b[2], t))})`;
  };
  const easeInOutCubic = (t) => {
    t = clamp(t, 0, 1);
    return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const randomSigned = (min, max) => randomBetween(min, max) * (Math.random() < .5 ? -1 : 1);
  const wrapAngle = (angle) => {
    while (angle > Math.PI) angle -= TAU;
    while (angle < -Math.PI) angle += TAU;
    return angle;
  };

  const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
  const add = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
  const scaleVec = (a, scalar) => vec(a.x * scalar, a.y * scalar, a.z * scalar);
  const lerpVec = (a, b, t) => vec(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const length = (a) => Math.sqrt(dot(a, a));
  const normalize = (a) => {
    const len = length(a) || 1;
    return scaleVec(a, 1 / len);
  };
  const cloneVec = (a) => vec(a.x, a.y, a.z);
  const cloneAngles = (a) => ({ x: a.x, y: a.y, z: a.z });
  const approachAngle = (from, to, amount) => from + wrapAngle(to - from) * amount;

  function rotatePoint(point, rotation) {
    let { x, y, z } = point;

    const cosZ = Math.cos(rotation.z);
    const sinZ = Math.sin(rotation.z);
    [x, y] = [x * cosZ - y * sinZ, x * sinZ + y * cosZ];

    const cosY = Math.cos(rotation.y);
    const sinY = Math.sin(rotation.y);
    [x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY];

    const cosX = Math.cos(rotation.x);
    const sinX = Math.sin(rotation.x);
    [y, z] = [y * cosX - z * sinX, y * sinX + z * cosX];

    return vec(x, y, z);
  }

  function rotateNormal(normal, rotation) {
    return normalize(rotatePoint(normal, rotation));
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
    if (app.state === 'grid' || app.state === 'transition') {
      updateGridTargets();
    }
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

  function transformedVertices(cube, options = {}) {
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
      return add(cube.position, rotatePoint(local, cube.rotation));
    });
  }

  function faceCenter(cube, face) {
    return add(cube.position, rotatePoint(scaleVec(face.normal, cube.half), cube.rotation));
  }

  function faceNormal(cube, face) {
    return rotateNormal(face.normal, cube.rotation);
  }

  function makeProjectedPoint(cube, localPoint, options) {
    const world = add(cube.position, rotatePoint(scaleVec(localPoint, cube.half), cube.rotation));
    const projected = worldToScreen(world);
    projected.x += options.offsetX || 0;
    projected.y += options.offsetY || 0;
    projected.world = world;
    return projected;
  }

  function strokeProjectedPath(points, color, width, alpha = 1, glow = 0) {
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
    ctx.stroke();
    ctx.restore();
  }

  function drawLocalStroke(cube, points, color, width, options, alpha = 1) {
    const projected = points.map((point) => {
      const local = Array.isArray(point)
        ? vec(point[0], point[1], point[2] || 0)
        : point;
      return makeProjectedPoint(cube, local, options);
    });
    strokeProjectedPath(projected, color, width, alpha);
  }

  function drawChevron(cube, face, a, tip, b, options, alpha) {
    const mapPoint = ([u, v]) => face.map(u, v);
    drawLocalStroke(cube, [mapPoint(a), mapPoint(tip)], VECTOR_COLOR, Math.max(.72, cube.half * 2.15), options, alpha);
    drawLocalStroke(cube, [mapPoint(tip), mapPoint(b)], VECTOR_COLOR, Math.max(.72, cube.half * 2.15), options, alpha);
  }

  function drawFaceTexture(cube, face, options, facing) {
    const visibility = clamp(.38 + facing * .62, .12, 1);
    const alpha = (options.textureAlpha ?? 1) * visibility;

    if (face.id === 'bottom') {

      drawChevron(cube, face, [-.20, FACE_ARROW_GAP], [0, FACE_ARROW_REACH], [.20, FACE_ARROW_GAP], options, alpha);
      drawChevron(cube, face, [-.20, -FACE_ARROW_GAP], [0, -FACE_ARROW_REACH], [.20, -FACE_ARROW_GAP], options, alpha);
      drawChevron(cube, face, [FACE_ARROW_GAP, -.20], [FACE_ARROW_REACH, 0], [FACE_ARROW_GAP, .20], options, alpha);
      drawChevron(cube, face, [-FACE_ARROW_GAP, -.20], [-FACE_ARROW_REACH, 0], [-FACE_ARROW_GAP, .20], options, alpha);
      return;
    }

    if (face.id === 'top') {

      drawChevron(cube, face, [-.20, .66], [0, FACE_ARROW_GAP], [.20, .66], options, alpha);
      drawChevron(cube, face, [-.20, -.66], [0, -FACE_ARROW_GAP], [.20, -.66], options, alpha);
      drawChevron(cube, face, [-.66, -.20], [-FACE_ARROW_GAP, 0], [-.66, .20], options, alpha);
      drawChevron(cube, face, [.66, -.20], [FACE_ARROW_GAP, 0], [.66, .20], options, alpha);
      return;
    }

    for (let row = 0; row < 3; row += 1) {
      const v = -.55 + row * .55;
      drawChevron(cube, face, [-.28, v - .13], [0, v + .13], [.28, v - .13], options, alpha);
    }
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

    const worldVertices = transformedVertices(cube, settings);
    const projectedVertices = worldVertices.map((world) => {
      const projected = worldToScreen(world);
      projected.x += settings.offsetX;
      projected.y += settings.offsetY;
      projected.world = world;
      return projected;
    });

    const cameraPosition = vec(0, 0, CAMERA_Z);
    const projectedFaces = faceDefs.map((face) => {
      const center = faceCenter(cube, face);
      const normal = faceNormal(cube, face);
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
      for (const item of projectedFaces) {
        const faceAlpha = settings.fillAlpha * clamp(.13 + Math.max(0, item.facing) * .22, .10, .36);
        ctx.save();
        ctx.globalAlpha = faceAlpha;
        ctx.fillStyle = FACE_COLOR;
        ctx.beginPath();
        ctx.moveTo(item.points[0].x, item.points[0].y);
        for (let i = 1; i < item.points.length; i += 1) ctx.lineTo(item.points[i].x, item.points[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      for (const item of projectedFaces) {
        const localAlpha = settings.textureAlpha * clamp(.24 + Math.max(0, item.facing) * .76, .2, 1);
        drawFaceTexture(cube, item.face, settings, item.facing);

        strokeProjectedPath(
          item.points.concat([item.points[0]]),
          settings.faceOutlineColor,
          Math.max(.45, cube.half * .48) * settings.faceOutlineScale,
          localAlpha * settings.faceOutlineAlpha,
          settings.faceGlow
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
    for (const [from, to] of cubeEdges) {
      ctx.beginPath();
      ctx.moveTo(projectedVertices[from].x, projectedVertices[from].y);
      ctx.lineTo(projectedVertices[to].x, projectedVertices[to].y);
      ctx.stroke();
    }
    ctx.restore();

    return {
      vertices: projectedVertices,
      faces: projectedFaces,
      bounds: getBounds(projectedVertices)
    };
  }

  function getBounds(points) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys)
    };
  }

  const orbitingBytes = Array.from({ length: 12 }, (_, index) => ({
    value: `0x${Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()}`,
    orbit: randomBetween(0, TAU),
    radius: randomBetween(1.65, 2.55),
    height: randomBetween(-1.35, 1.35),
    size: randomBetween(8.5, 13.5),
    speed: randomBetween(.045, .095) * (index % 2 ? -1 : 1),
    spin: randomBetween(-.45, .45),
    phase: randomBetween(0, TAU),
    opacity: randomBetween(.55, 1)
  }));

  const DIGITAL_SEGMENTS = {
    '0': ['a', 'b', 'c', 'd', 'e', 'f'],
    '1': ['b', 'c'],
    '2': ['a', 'b', 'd', 'e', 'g'],
    '3': ['a', 'b', 'c', 'd', 'g'],
    '4': ['b', 'c', 'f', 'g'],
    '5': ['a', 'c', 'd', 'f', 'g'],
    '6': ['a', 'c', 'd', 'e', 'f', 'g'],
    '7': ['a', 'b', 'c'],
    '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    '9': ['a', 'b', 'c', 'd', 'f', 'g'],
    A: ['a', 'b', 'c', 'e', 'f', 'g'],
    B: ['c', 'd', 'e', 'f', 'g'],
    C: ['a', 'd', 'e', 'f'],
    D: ['b', 'c', 'd', 'e', 'g'],
    E: ['a', 'd', 'e', 'f', 'g'],
    F: ['a', 'e', 'f', 'g'],
    x: ['x']
  };

  function drawDigitalByte(value, size) {
    const height = size;
    const width = size * .56;
    const thickness = Math.max(.8, size * .095);
    const gap = size * .14;
    const totalWidth = value.length * width + (value.length - 1) * gap;
    const top = -height / 2;
    const firstLeft = -totalWidth / 2;

    ctx.save();
    ctx.strokeStyle = SIGNAL_COLOR;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = SIGNAL_COLOR;
    ctx.shadowBlur = Math.max(3, size * .72);

    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      const left = firstLeft + index * (width + gap);
      const mid = top + height / 2;
      const inset = thickness * .55;
      const segments = {
        a: [left + inset, top + inset, left + width - inset, top + inset],
        b: [left + width - inset, top + inset, left + width - inset, mid - inset],
        c: [left + width - inset, mid + inset, left + width - inset, top + height - inset],
        d: [left + inset, top + height - inset, left + width - inset, top + height - inset],
        e: [left + inset, mid + inset, left + inset, top + height - inset],
        f: [left + inset, top + inset, left + inset, mid - inset],
        g: [left + inset, mid, left + width - inset, mid],
        x: [
          [left + inset, top + inset, left + width - inset, top + height - inset],
          [left + width - inset, top + inset, left + inset, top + height - inset]
        ]
      };

      for (const segment of DIGITAL_SEGMENTS[character] || []) {
        if (segment === 'x') {
          for (const diagonal of segments.x) {
            ctx.beginPath();
            ctx.moveTo(diagonal[0], diagonal[1]);
            ctx.lineTo(diagonal[2], diagonal[3]);
            ctx.stroke();
          }
          continue;
        }
        const line = segments[segment];
        ctx.beginPath();
        ctx.moveTo(line[0], line[1]);
        ctx.lineTo(line[2], line[3]);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function orbitingByteWorldPosition(particle, time) {
    const orbit = particle.orbit + time * .00012 * particle.speed * 12;
    const vertical = particle.height + Math.sin(time * .00055 + particle.phase) * .16;
    return vec(
      Math.cos(orbit) * particle.radius,
      vertical,
      Math.sin(orbit) * particle.radius * .68
    );
  }

  function drawOrbitingBytes(time, opacity) {
    if (opacity <= .001) return;
    ctx.save();
    for (const particle of orbitingBytes) {
      const world = orbitingByteWorldPosition(particle, time);
      const center = worldToScreen(world);
      const depthScale = CAMERA_FOCAL / Math.max(.8, CAMERA_Z - world.z);
      const fontSize = clamp(particle.size * depthScale * (viewport.scale / 240), 7, 14);
      const particleOpacity = opacity * particle.opacity * clamp(.72 + depthScale * .18, .72, 1);
      const rotation = particle.phase + time * .0004 * particle.spin;

      ctx.globalAlpha = particleOpacity;
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(rotation);
      drawDigitalByte(particle.value, fontSize);
      ctx.restore();
    }
    ctx.restore();
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

  function playClickPop() {
    return playRandomGlitchSound();
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
    triggerMasterRotationBoost(time);
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

  function disableGlitchAfterSplit() {
    glitch.enabled = false;
    glitch.active = false;
    glitch.intensity = 0;
    glitch.audioPlayed = false;
    glitch.nextAt = Infinity;
    master.rotationBoost = null;
  }

  const master = {
    position: vec(0, 0, 0),
    half: MASTER_HALF,
    rotation: { x: .37, y: -.55, z: .18 },
    velocity: { x: .12, y: .22, z: -.075 },
    velocityTarget: { x: .12, y: .22, z: -.075 },
    rotationBoost: null,
    driftAt: randomBetween(3000, 5000),
    hit: null,
    hovered: false,
    hoverScale: 1,
    hoverStrength: 0
  };

  const app = {
    state: 'boot',
    transitionStartedAt: 0,
    transitionDuration: 1720,
    hexOpacity: 1,
    hoveredIndex: -1,
    pointer: { x: -9999, y: -9999 },
    minis: [],
    lastTime: performance.now(),
  };

  const bootSequence = {
    startedAt: 0,
    duration: 300,
    seed: 0,
    buffer: null,
    bufferContext: null
  };
  let isBooted = false;

  function triggerMasterRotationBoost(time) {
    const base = {
      x: randomSigned(.14, .27),
      y: randomSigned(.24, .43),
      z: randomSigned(.08, .17)
    };
    const burst = {
      x: Math.sign(base.x) * (Math.abs(base.x) + randomBetween(.28, .5)),
      y: Math.sign(base.y) * (Math.abs(base.y) + randomBetween(.42, .72)),
      z: Math.sign(base.z) * (Math.abs(base.z) + randomBetween(.16, .3))
    };
    master.velocityTarget = base;
    master.velocity = burst;
    master.rotationBoost = {
      startedAt: time,
      duration: randomBetween(1200, 1800),
      burstVelocity: burst
    };
    master.driftAt = time + randomBetween(3000, 5000);
  }

  function makeMiniCube(index, column, row, depth) {
    return {
      index,
      column,
      row,
      depth,
      label: navItems[index].label,
      href: navItems[index].href,
      startPosition: vec(),
      targetPosition: vec(),
      position: vec(),
      half: MINI_CLUSTER_HALF,
      rotation: cloneAngles(master.rotation),
      startRotation: cloneAngles(master.rotation),
      targetRotation: {
        x: master.rotation.x + randomBetween(-.26, .26),
        y: master.rotation.y + randomBetween(-.42, .42),
        z: master.rotation.z + randomBetween(-.2, .2)
      },
      velocity: {
        x: randomBetween(-.055, .055),
        y: randomBetween(-.07, .07),
        z: randomBetween(-.045, .045)
      },
      wobble: randomBetween(0, TAU),
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
    }
  }

  function beginSplit(time) {
    if (app.state !== 'idle') return;

    disableGlitchAfterSplit();
    unlockStaticGlitchAudio();
    playClickPop();
    app.state = 'transition';
    app.transitionStartedAt = time;
    app.hexOpacity = 1;
    app.hoveredIndex = -1;
    master.hit = null;
    master.hovered = false;
    master.hoverScale = 1;
    master.hoverStrength = 0;
    buildMinis();

    for (const mini of app.minis) {
      const offset = vec(
        mini.column % 2 ? MINI_CLUSTER_HALF : -MINI_CLUSTER_HALF,
        mini.row ? -MINI_CLUSTER_HALF : MINI_CLUSTER_HALF,
        Math.floor(mini.column / 2) ? MINI_CLUSTER_HALF : -MINI_CLUSTER_HALF
      );
      mini.startPosition = add(master.position, rotatePoint(offset, master.rotation));
      mini.position = cloneVec(mini.startPosition);
      mini.startRotation = cloneAngles(master.rotation);
      mini.rotation = cloneAngles(master.rotation);
    }
    updateGridTargets();
    modeReadout.textContent = 'SPLIT SEQUENCE';
    hintReadout.textContent = 'DIMENSIONS UNLOCKING';
  }

  function updateTransition(time) {
    const raw = clamp((time - app.transitionStartedAt) / app.transitionDuration, 0, 1);
    const motion = easeInOutCubic(raw);
    app.hexOpacity = 1 - easeOutCubic(clamp(raw / .42, 0, 1));

    for (const mini of app.minis) {
      mini.position = lerpVec(mini.startPosition, mini.targetPosition, motion);
      mini.half = lerp(MINI_CLUSTER_HALF, MINI_GRID_HALF, easeOutCubic(clamp(raw / .78, 0, 1)));
      mini.rotation = {
        x: approachAngle(mini.startRotation.x, mini.targetRotation.x, motion),
        y: approachAngle(mini.startRotation.y, mini.targetRotation.y, motion),
        z: approachAngle(mini.startRotation.z, mini.targetRotation.z, motion)
      };
    }

    if (raw >= 1) {
      app.state = 'grid';
      app.hexOpacity = 0;
      for (const mini of app.minis) {
        mini.position = cloneVec(mini.targetPosition);
        mini.half = MINI_GRID_HALF;
      }
      modeReadout.textContent = 'GRID ONLINE';
      hintReadout.textContent = 'SELECT A DIMENSION';
    }
  }

  function updateMaster(dt, time) {
    if (time >= master.driftAt) {
      master.velocityTarget = {
        x: randomBetween(-.19, .19),
        y: randomBetween(-.28, .28),
        z: randomBetween(-.12, .12)
      };
      master.driftAt = time + randomBetween(3000, 5000);
    }
    let targetVelocity = master.velocityTarget;
    if (master.rotationBoost) {
      const progress = clamp((time - master.rotationBoost.startedAt) / master.rotationBoost.duration, 0, 1);
      const decay = 1 - easeInOutCubic(progress);
      targetVelocity = {
        x: lerp(master.velocityTarget.x, master.rotationBoost.burstVelocity.x, decay),
        y: lerp(master.velocityTarget.y, master.rotationBoost.burstVelocity.y, decay),
        z: lerp(master.velocityTarget.z, master.rotationBoost.burstVelocity.z, decay)
      };
      if (progress >= 1) master.rotationBoost = null;
    }
    const smoothing = 1 - Math.pow(.002, dt);
    master.velocity.x = lerp(master.velocity.x, targetVelocity.x, smoothing);
    master.velocity.y = lerp(master.velocity.y, targetVelocity.y, smoothing);
    master.velocity.z = lerp(master.velocity.z, targetVelocity.z, smoothing);
    master.rotation.x += master.velocity.x * dt;
    master.rotation.y += master.velocity.y * dt;
    master.rotation.z += master.velocity.z * dt;

    const targetHover = master.hovered ? 1 : 0;

    const hoverSmoothing = 1 - Math.pow(.001, dt / .24);
    master.hoverStrength = lerp(master.hoverStrength, targetHover, hoverSmoothing);
    const targetScale = 1 + targetHover * .1;
    master.hoverScale = lerp(master.hoverScale, targetScale, hoverSmoothing);
  }

  function updateBootSequence(time) {
    const progress = clamp((time - bootSequence.startedAt) / bootSequence.duration, 0, 1);
    if (progress < 1) return;
    isBooted = true;
    app.state = 'idle';
    glitch.nextAt = time + randomBetween(4000, 8000);
    document.body.classList.remove('booting');
    canvas.style.transform = '';
  }

  function beginBootSequence(time) {
    if (isBooted || app.state !== 'boot') return;
    bootSequence.startedAt = time;
    bootSequence.duration = randomBetween(240, 330);
    bootSequence.seed = Math.random() * 10000;
    app.state = 'booting';
    terminalLaunch.classList.add('is-docking');
    terminalLaunch.setAttribute('aria-disabled', 'true');
    bootPrompt.classList.add('is-hidden');
    bootPrompt.setAttribute('aria-hidden', 'true');
    canvas.classList.add('is-visible');

    unlockStaticGlitchAudio();
    playClickPop();

    app.lastTime = time;
    requestAnimationFrame(frame);
  }

  function ensureBootGlitchBuffer() {
    if (bootSequence.buffer &&
        bootSequence.buffer.width === canvas.width &&
        bootSequence.buffer.height === canvas.height) {
      return Boolean(bootSequence.bufferContext);
    }

    bootSequence.buffer = document.createElement('canvas');
    bootSequence.buffer.width = canvas.width;
    bootSequence.buffer.height = canvas.height;
    bootSequence.bufferContext = bootSequence.buffer.getContext('2d');
    return Boolean(bootSequence.bufferContext);
  }

  function drawBootGlitch(time) {
    const progress = clamp((time - bootSequence.startedAt) / bootSequence.duration, 0, 1);
    const pulse = Math.sin(Math.PI * progress);
    if (pulse < .01) {
      canvas.style.transform = '';
      return;
    }

    const frameSeed = bootSequence.seed + Math.floor(time / 16.6667);
    const shakeX = hashNoise(frameSeed + 12) * 10 * pulse;
    const shakeY = hashNoise(frameSeed + 37) * 7 * pulse;
    canvas.style.transform = `translate(${shakeX.toFixed(2)}px, ${shakeY.toFixed(2)}px)`;

    if (!ensureBootGlitchBuffer()) return;
    const bufferContext = bootSequence.bufferContext;
    const width = canvas.width;
    const height = canvas.height;
    const dpr = viewport.dpr;

    bufferContext.setTransform(1, 0, 0, 1, 0, 0);
    bufferContext.clearRect(0, 0, width, height);
    bufferContext.drawImage(canvas, 0, 0);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const channelOffset = Math.round((5 + 9 * pulse) * dpr);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = .3 * pulse;
    ctx.filter = `contrast(${1.35 + pulse * .8}) saturate(4) hue-rotate(145deg)`;
    ctx.drawImage(bootSequence.buffer, channelOffset, 0);
    ctx.filter = `contrast(${1.35 + pulse * .8}) saturate(5) hue-rotate(295deg)`;
    ctx.drawImage(bootSequence.buffer, -channelOffset, 0);
    ctx.filter = 'none';

    const sliceCount = 10 + Math.floor(pulse * 8);
    for (let i = 0; i < sliceCount; i += 1) {
      const sliceY = Math.floor(((i + .5) / sliceCount) * height);
      const sliceHeight = Math.max(2, Math.floor((2 + Math.abs(hashNoise(frameSeed + i * 2.7)) * 7) * dpr));
      const displacement = Math.round(hashNoise(frameSeed + 90 + i * 4.1) * (12 + pulse * 28) * dpr);
      const sourceY = clamp(sliceY - Math.floor(sliceHeight / 2), 0, height - sliceHeight);
      const tint = i % 2 ? 'rgba(255, 43, 181, .22)' : 'rgba(0, 240, 255, .24)';

      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = (.22 + Math.abs(hashNoise(frameSeed + i)) * .2) * pulse;
      ctx.drawImage(
        bootSequence.buffer,
        0, sourceY, width, sliceHeight,
        displacement, sourceY, width, sliceHeight
      );
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = .72 * pulse;
      ctx.fillStyle = tint;
      ctx.fillRect(0, sourceY, width, Math.max(1, Math.ceil(dpr)));
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = .09 * pulse;
    ctx.fillStyle = 'rgba(0, 240, 255, .9)';
    const lineStep = Math.max(3, Math.round(5 * dpr));
    for (let y = 0; y < height; y += lineStep) {
      ctx.fillRect(0, y, width, Math.max(1, Math.round(dpr * .42)));
    }
    ctx.restore();
  }

  function updateMinis(dt, time) {
    for (const mini of app.minis) {
      const speed = app.hoveredIndex === mini.index ? 1.12 : 1;
      mini.rotation.x += mini.velocity.x * dt * speed;
      mini.rotation.y += mini.velocity.y * dt * speed;
      mini.rotation.z += mini.velocity.z * dt * speed;
      mini.position.y += Math.sin(time * .0007 + mini.wobble) * .00065 * dt;
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
    if (app.state === 'idle') return cubeIsHit(point, master.hit, 9) ? 'master' : -1;
    if (app.state === 'grid') {
      for (let i = app.minis.length - 1; i >= 0; i -= 1) {
        if (cubeIsHit(point, app.minis[i].hit, 6)) return i;
      }
    }
    return -1;
  }

  function updateHover() {
    const hit = hitTest(app.pointer);
    const next = typeof hit === 'number' ? hit : -1;
    app.hoveredIndex = next;
    master.hovered = app.state === 'idle' && hit === 'master';
    if (app.state === 'grid') {
      for (const mini of app.minis) mini.hovered = mini.index === next;
    }
    canvas.style.cursor = hit === 'master' || next >= 0 ? 'pointer' : 'default';
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

  function renderMaster(time) {
    const hoverStrength = master.hoverStrength;
    const renderTarget = { ...master, half: master.half * master.hoverScale };
    const glitchActive = glitch.active;
    const frameSeed = glitch.seed + Math.floor(time / 16.6667);
    if (glitchActive) {

      renderCube(renderTarget, {
        wireOnly: true,
        edgeColor: GLITCH_MAGENTA,
        edgeAlpha: .92 * glitch.intensity,
        offsetX: -7.5 * glitch.intensity,
        offsetY: 1.2 * glitch.intensity,
        vertexJitter: .11 * glitch.intensity,
        seed: frameSeed + 8
      });
      renderCube(renderTarget, {
        wireOnly: true,
        edgeColor: GLITCH_CYAN,
        edgeAlpha: .96 * glitch.intensity,
        offsetX: 7.5 * glitch.intensity,
        offsetY: -1.2 * glitch.intensity,
        vertexJitter: .105 * glitch.intensity,
        seed: frameSeed + 29
      });
    }
    master.hit = renderCube(renderTarget, {
      vertexJitter: glitchActive ? .085 * glitch.intensity : 0,
      seed: frameSeed,
      edgeAlpha: glitchActive ? .96 : 1,
      edgeGlow: lerp(1, 2.8, hoverStrength),
      faceOutlineColor: blendHexColor(VECTOR_COLOR, EDGE_COLOR, hoverStrength),
      faceOutlineAlpha: lerp(.28, .82, hoverStrength),
      faceOutlineScale: lerp(1, 1.35, hoverStrength),
      faceGlow: lerp(0, 10, hoverStrength)
    });
  }

  function renderBootSequence(time) {
    const progress = clamp((time - bootSequence.startedAt) / bootSequence.duration, 0, 1);
    const reveal = easeOutCubic(clamp((progress - .08) / .68, 0, 1));

    drawBackground(time);
    if (reveal > .001) {
      ctx.save();
      ctx.globalAlpha = reveal;
      drawOrbitingBytes(time, 1);
      renderMaster(time);
      ctx.restore();
    } else {
      master.hit = null;
    }
    drawBootGlitch(time);
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
    updateGlitch(time);

    if (app.state === 'idle') {
      drawOrbitingBytes(time, app.hexOpacity);
      renderMaster(time);
    } else {
      if (app.state === 'transition') updateTransition(time);
      if (app.hexOpacity > .001) drawOrbitingBytes(time, app.hexOpacity);

      for (const mini of app.minis) renderMini(mini, time);
      if (app.state === 'grid') {
        for (const mini of app.minis) drawCubeLabel(mini);
      }
    }

    if (app.state === 'idle' || app.state === 'grid') updateHover();
  }

  function frame(time) {
    const elapsed = Math.min(42, time - app.lastTime);
    const dt = elapsed / 1000;
    app.lastTime = time;

    const booting = app.state === 'booting';
    if (booting) {
      updateMaster(dt, time);
      updateBootSequence(time);
      renderBootSequence(time);
    } else {
      if (app.state === 'idle') updateMaster(dt, time);
      if (app.state === 'grid') updateMinis(dt, time);
      render(time);
    }
    requestAnimationFrame(frame);
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  window.addEventListener('pointerdown', unlockStaticGlitchAudio, { capture: true });
  window.addEventListener('touchstart', unlockStaticGlitchAudio, { capture: true, passive: true });
  window.addEventListener('keydown', (event) => {
    unlockStaticGlitchAudio();
    if (!isBooted && app.state === 'boot' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      beginBootSequence(performance.now());
    }
  }, { capture: true });

  terminalLaunch.addEventListener('click', () => {
    beginBootSequence(performance.now());
  });

  canvas.addEventListener('pointermove', (event) => {
    app.pointer = pointerPosition(event);
    updateHover();
  });

  canvas.addEventListener('pointerleave', () => {
    app.pointer = { x: -9999, y: -9999 };
    app.hoveredIndex = -1;
    master.hovered = false;
    for (const mini of app.minis) mini.hovered = false;
    canvas.style.cursor = 'default';
  });

  canvas.addEventListener('pointerdown', (event) => {
    unlockStaticGlitchAudio();
    app.pointer = pointerPosition(event);
    const hit = hitTest(app.pointer);
    if (hit === 'master') {
      beginSplit(performance.now());
      return;
    }
    if (typeof hit === 'number' && app.state === 'grid') {
      const destination = app.minis[hit].href;
      window.location.assign(destination);
    }
  });

  canvas.addEventListener('keydown', (event) => {
    unlockStaticGlitchAudio();
    if ((event.key === 'Enter' || event.key === ' ') && app.state === 'idle') {
      event.preventDefault();
      beginSplit(performance.now());
    }
  });

  window.addEventListener('resize', resizeCanvas, { passive: true });

  preloadStaticGlitchAudio();
  resizeCanvas();
})();
