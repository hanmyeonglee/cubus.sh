(() => {
  'use strict';

  const canvas = document.getElementById('scene');
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: true,
    depth: false,
    stencil: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  });
  if (!gl) {
    canvas.dataset.renderer = 'unavailable';
    throw new Error('[CUBUS RENDERER] WebGL2 is required.');
  }
  const bunkerWallCanvas = document.getElementById('bunker-wall');
  const bunkerWallCtx = bunkerWallCanvas.getContext('2d');
  const bunkerFxCanvas = document.getElementById('bunker-fx');
  const bunkerFxCtx = bunkerFxCanvas.getContext('2d');
  const bunkerWallCacheCanvas = document.createElement('canvas');
  const bunkerWallCacheCtx = bunkerWallCacheCanvas.getContext('2d');
  const bunkerWallRestingCacheCanvas = document.createElement('canvas');
  const bunkerWallRestingCacheCtx = bunkerWallRestingCacheCanvas.getContext('2d');
  const bunkerWallTextureCanvas = document.createElement('canvas');
  const bunkerWallTextureCtx = bunkerWallTextureCanvas.getContext('2d');
  const bunkerHazardCanvas = document.createElement('canvas');
  const bunkerHazardCtx = bunkerHazardCanvas.getContext('2d');
  let bunkerHazardPattern = null;
  let bunkerFxVisible = false;
  let bunkerFxDirtyBounds = [];

  bunkerHazardCanvas.width = 36;
  bunkerHazardCanvas.height = 36;
  bunkerHazardCtx.fillStyle = '#101417';
  bunkerHazardCtx.fillRect(0, 0, 36, 36);
  bunkerHazardCtx.fillStyle = '#e0a328';
  for (let stripeX = -36; stripeX < 72; stripeX += 18) {
    bunkerHazardCtx.beginPath();
    bunkerHazardCtx.moveTo(stripeX, 36);
    bunkerHazardCtx.lineTo(stripeX + 10, 36);
    bunkerHazardCtx.lineTo(stripeX + 46, 0);
    bunkerHazardCtx.lineTo(stripeX + 36, 0);
    bunkerHazardCtx.closePath();
    bunkerHazardCtx.fill();
  }

  const TAU = Math.PI * 2;
  const CAMERA_Z = 7.8;
  const CAMERA_FOCAL = 6.7;
  const MINI_FRAME_FILL_RATIO = .86;
  const MINI_CUBE_SCALE = .8;
  const EDGE_COLOR = '#f4ffff';
  const VECTOR_COLOR = '#51f7d1';
  const FACE_COLOR = '#07121a';
  const GLITCH_CYAN = '#00f0ff';
  const GLITCH_MAGENTA = '#ff2bb5';
  const FONT_STACK = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

  const navItems = [
    { href: 'https://about.cubus.sh' },
    { href: '#undefined' },
    { href: '#undefined' },
    { href: '#undefined' },
    { href: '#undefined' },
    { href: '#undefined' },
    { href: '#undefined' },
    { href: '#undefined' }
  ];

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOutCubic = (t) => {
    t = clamp(t, 0, 1);
    return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const randomSigned = (min, max) => randomBetween(min, max) * (Math.random() < .5 ? -1 : 1);

  function isExternalHttpLink(href) {
    if (typeof href !== 'string' || !href.trim()) return false;
    try {
      const pageUrl = new URL(window.location.href);
      const targetUrl = new URL(href, pageUrl);
      return (targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:') &&
        targetUrl.origin !== pageUrl.origin;
    } catch {
      return false;
    }
  }

  const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
  const CAMERA_POSITION = vec(0, 0, CAMERA_Z);

  let bunkerWallCacheReady = false;
  let bunkerWallInitialized = false;
  let bunkerWallVisualStates = [];

  const bulkheadState = {
    bays: Array.from({ length: navItems.length }, () => ({
      isOpened: false,
      isOpening: false,
      openingStartedAt: 0,
      accessResult: null,
      keypadSequence: [],
      wallPulseUntil: 0
    }))
  };

  const BULKHEAD_TIMING = {
    keypadDuration: 500,
    grantedDisplayDuration: 100,
    unlockDuration: 400,
    slideDuration: 800,
    deniedDisplayDuration: 300,
    deniedWarningDuration: 400,
    deniedResetDuration: 1500
  };
  const BULKHEAD_GRANTED_SLIDE_START = BULKHEAD_TIMING.keypadDuration +
    BULKHEAD_TIMING.grantedDisplayDuration + BULKHEAD_TIMING.unlockDuration;
  const BULKHEAD_TOTAL_DURATION = BULKHEAD_TIMING.keypadDuration +
    BULKHEAD_TIMING.grantedDisplayDuration +
    BULKHEAD_TIMING.unlockDuration +
    BULKHEAD_TIMING.slideDuration;
  const BULKHEAD_DENIED_WARNING_START = BULKHEAD_TIMING.keypadDuration +
    BULKHEAD_TIMING.deniedDisplayDuration;
  const NO_BULKHEAD_FEEDBACK = Object.freeze({ tone: '', rgb: '', color: '', intensity: 0 });
  const CLOSED_BULKHEAD_STATE = Object.freeze({
    isOpened: false,
    isOpening: false,
    openingStartedAt: 0,
    accessResult: null,
    keypadSequence: Object.freeze([]),
    wallPulseUntil: 0
  });
  const BUNKER_APERTURE_HIT_INSET = -3;
  const BUNKER_APERTURE_FX_PADDING = -3;
  const BUNKER_APERTURE_FRAME_PADDING_MAX = 18;
  const BUNKER_APERTURE_FRAME_PADDING_RATIO = .12;
  const BUNKER_APERTURE_FRAME_STROKE_HALF = 2.5;
  const BUNKER_APERTURE_PLATE_PADDING_RATIO = .13;
  const BUNKER_APERTURE_PLATE_PADDING_MIN = 8;
  const BUNKER_APERTURE_PLATE_PADDING_MAX = 30;
  const BUNKER_APERTURE_PLATE_STROKE_HALF = .5;
  const BUNKER_APERTURE_MIN_GAP = 8; // Minimum clear space between complete outer bounds.
  const BUNKER_APERTURE_MAX_GAP = 56; // Prevents the grid from spreading across ultrawide screens.
  const BUNKER_APERTURE_MAX_SIZE = 220;
  const KEYPAD_KEY_COUNT = 20;

  function createKeypadSequence() {
    const indices = Array.from({ length: KEYPAD_KEY_COUNT }, (_, index) => index);
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const swapIndex = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[swapIndex]] = [indices[swapIndex], indices[i]];
    }
    const count = 4 + Math.floor(Math.random() * 2);
    const interval = BULKHEAD_TIMING.keypadDuration / count;
    const pressDuration = Math.min(78, interval * .72);
    return indices.slice(0, count).map((keyIndex, order) => ({
      keyIndex,
      start: order * interval,
      duration: pressDuration,
      played: false
    }));
  }

  function getKeypadEnteredCount(state, time) {
    if (!state || !state.isOpening || !state.keypadSequence.length) return 0;
    const elapsed = time - state.openingStartedAt;
    let count = 0;
    for (const entry of state.keypadSequence) {
      if (elapsed >= entry.start) count += 1;
    }
    return count;
  }

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

  function getFaceFacing(cube, normal, rotation) {
    let { x, y, z } = normal;

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

    const centerX = cube.position.x + x * cube.half;
    const centerY = cube.position.y + y * cube.half;
    const centerZ = cube.position.z + z * cube.half;
    const toCameraX = CAMERA_POSITION.x + centerX * -1;
    const toCameraY = CAMERA_POSITION.y + centerY * -1;
    const toCameraZ = CAMERA_POSITION.z + centerZ * -1;
    const toCameraLength = Math.sqrt(
      toCameraX * toCameraX + toCameraY * toCameraY + toCameraZ * toCameraZ
    ) || 1;
    const inverseLength = 1 / toCameraLength;
    return x * (toCameraX * inverseLength) +
      y * (toCameraY * inverseLength) +
      z * (toCameraZ * inverseLength);
  }

  function hashNoise(seed) {
    const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return (value - Math.floor(value)) * 2 - 1;
  }

  function buildBunkerWallTextureTile() {
    const size = 128;
    bunkerWallTextureCanvas.width = size;
    bunkerWallTextureCanvas.height = size;
    bunkerWallTextureCtx.clearRect(0, 0, size, size);

    const drawWrappedMark = (x, y, width, height, color) => {
      bunkerWallTextureCtx.fillStyle = color;
      for (const offsetX of [-size, 0, size]) {
        for (const offsetY of [-size, 0, size]) {
          const wrappedX = x + offsetX;
          const wrappedY = y + offsetY;
          if (wrappedX + width <= 0 || wrappedX >= size || wrappedY + height <= 0 || wrappedY >= size) continue;
          bunkerWallTextureCtx.fillRect(wrappedX, wrappedY, width, height);
        }
      }
    };

    for (let index = 0; index < 720; index += 1) {
      const x = ((hashNoise(index * 2.71 + 4) + 1) / 2) * size;
      const y = ((hashNoise(index * 4.83 + 19) + 1) / 2) * size;
      const tone = (hashNoise(index * 8.19 + 33) + 1) / 2;
      const markSize = tone > .84 ? 2 : 1;
      const alpha = tone > .55 ? .052 : .078;
      const color = tone > .55
        ? `rgba(215, 217, 204, ${alpha})`
        : `rgba(0, 0, 0, ${alpha})`;
      drawWrappedMark(x, y, markSize, markSize, color);
    }

    for (let index = 0; index < 36; index += 1) {
      const x = ((hashNoise(index * 11.13 + 71) + 1) / 2) * size;
      const y = ((hashNoise(index * 13.47 + 29) + 1) / 2) * size;
      const length = 3 + Math.round(((hashNoise(index * 5.31 + 101) + 1) / 2) * 8);
      drawWrappedMark(x, y, length, 1, 'rgba(0, 0, 0, .11)');
    }
  }

  buildBunkerWallTextureTile();

  const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
  const hoverPointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
  const getRenderDpr = () => Math.min(window.devicePixelRatio || 1, coarsePointerQuery.matches ? 1.5 : 2);

  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: getRenderDpr(),
    centerX: window.innerWidth / 2,
    centerY: window.innerHeight / 2,
    scale: Math.min(window.innerWidth, window.innerHeight) * .30,
    stars: [],
    visibleStars: []
  };

  function getGridShape() {
    const columns = viewport.height > viewport.width ? 2 : 4;
    return { columns, rows: navItems.length / columns };
  }

  function fitApertureSizeToPitch(preferredSize, pitch) {
    let lower = 0;
    let upper = preferredSize;
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const candidate = (lower + upper) / 2;
      const outerInset = getApertureOuterInset(candidate);
      if (candidate + outerInset * 2 + BUNKER_APERTURE_MIN_GAP <= pitch) lower = candidate;
      else upper = candidate;
    }
    return lower;
  }

  function getResponsiveGridLayout() {
    const gridShape = getGridShape();
    const verticalInset = viewport.height * (gridShape.rows === 2 ? .12 : .06);
    const outerWallMargin = clamp(Math.min(viewport.width, viewport.height) * .035, 12, 48);
    const availablePitchX = Math.max(1, viewport.width - outerWallMargin * 2) / gridShape.columns;
    const availablePitchY = (viewport.height - verticalInset * 2) / gridShape.rows;
    const largestCenterPitch = BUNKER_APERTURE_MAX_SIZE +
      getApertureOuterInset(BUNKER_APERTURE_MAX_SIZE) * 2 + BUNKER_APERTURE_MAX_GAP;
    const sizingPitchX = Math.min(availablePitchX, largestCenterPitch);
    const sizingPitchY = Math.min(availablePitchY, largestCenterPitch);
    const preferredSize = Math.min(BUNKER_APERTURE_MAX_SIZE, Math.min(sizingPitchX, sizingPitchY) * .82);
    const apertureSize = fitApertureSizeToPitch(preferredSize, Math.min(sizingPitchX, sizingPitchY));
    const maxCenterPitch = apertureSize + getApertureOuterInset(apertureSize) * 2 + BUNKER_APERTURE_MAX_GAP;
    const pitchX = Math.min(availablePitchX, maxCenterPitch);
    const pitchY = Math.min(availablePitchY, maxCenterPitch);
    return { ...gridShape, pitchX, pitchY, apertureSize, outerWallMargin };
  }

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
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = getRenderDpr();
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (
      canvas.width === pixelWidth &&
      canvas.height === pixelHeight &&
      viewport.width === width &&
      viewport.height === height &&
      viewport.dpr === dpr &&
      bunkerWallCacheReady
    ) return;

    viewport.width = width;
    viewport.height = height;
    viewport.dpr = dpr;
    viewport.centerX = viewport.width / 2;
    viewport.centerY = viewport.height / 2;
    viewport.scale = Math.min(viewport.width, viewport.height) * .30;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    rebuildStars();
    if (app.minis.length) {
      updateGridTargets();
      resizeBunkerWall();
    }
    if (gpuRenderer) gpuRenderer.resize();
  }

  function screenToWorld(x, y, z = 0) {
    const depth = Math.max(.8, CAMERA_Z - z);
    const perspective = CAMERA_FOCAL / depth;
    const unit = viewport.scale * perspective;
    return vec((x - viewport.centerX) / unit, -(y - viewport.centerY) / unit, z);
  }

  function getApertureFramePadding(size) {
    return Math.min(BUNKER_APERTURE_FRAME_PADDING_MAX, size * BUNKER_APERTURE_FRAME_PADDING_RATIO);
  }

  function getAperturePlatePadding(size) {
    return clamp(
      size * BUNKER_APERTURE_PLATE_PADDING_RATIO,
      BUNKER_APERTURE_PLATE_PADDING_MIN,
      BUNKER_APERTURE_PLATE_PADDING_MAX
    );
  }

  function getApertureOuterInset(size) {
    // Include both the beveled frame stroke and the enclosing armor-plate stroke.
    const framedEdge = getApertureFramePadding(size) + BUNKER_APERTURE_FRAME_STROKE_HALF;
    const platedEdge = getAperturePlatePadding(size) + BUNKER_APERTURE_PLATE_STROKE_HALF;
    return Math.max(framedEdge, platedEdge);
  }

  function getMiniCubeHalfForFrame(mini, frameSize) {
    const cameraDepth = CAMERA_Z - mini.depth;
    const centerExtent = Math.max(Math.abs(mini.position.x), Math.abs(mini.position.y));
    const projectedCornerFactor = 2 * viewport.scale * CAMERA_FOCAL *
      Math.hypot(cameraDepth, centerExtent);
    const fill = MINI_FRAME_FILL_RATIO * frameSize;
    const cornerRadius = fill * cameraDepth * cameraDepth /
      (projectedCornerFactor + fill * cameraDepth);
    return cornerRadius / Math.sqrt(3) * MINI_CUBE_SCALE;
  }

  function getApertureOuterBounds(aperture) {
    const width = aperture.width;
    const height = aperture.height;
    const outerInset = getApertureOuterInset(Math.max(width, height));
    return {
      left: aperture.x - width / 2 - outerInset,
      top: aperture.y - height / 2 - outerInset,
      width: width + outerInset * 2,
      height: height + outerInset * 2
    };
  }

  function getBunkerAperturePoints(aperture, padding = 0) {
    const width = aperture.width + padding * 2;
    const height = aperture.height + padding * 2;
    const cut = clamp(aperture.cut + padding * .18, 8, Math.min(width, height) * .24);
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const left = aperture.x - halfWidth;
    const right = aperture.x + halfWidth;
    const top = aperture.y - halfHeight;
    const bottom = aperture.y + halfHeight;
    return [
      { x: left + cut, y: top },
      { x: right - cut, y: top },
      { x: right, y: top + cut },
      { x: right, y: bottom - cut },
      { x: right - cut, y: bottom },
      { x: left + cut, y: bottom },
      { x: left, y: bottom - cut },
      { x: left, y: top + cut }
    ];
  }

  function getClosedPathLength(points) {
    let length = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      const deltaX = next.x - current.x;
      const deltaY = next.y - current.y;
      length += Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    }
    return length;
  }

  function createApertureFxGeometry(aperture) {
    const path = getBunkerAperturePoints(aperture, BUNKER_APERTURE_FX_PADDING);
    const perimeter = getClosedPathLength(path);
    const createLedSet = (segmentLength) => {
      const gapLength = Math.max(2, (perimeter - segmentLength * 4) / 4);
      const dash = [
        segmentLength, gapLength,
        segmentLength, gapLength,
        segmentLength, gapLength,
        segmentLength, gapLength
      ];
      return {
        dash,
        cycle: dash.reduce((sum, value) => sum + value, 0)
      };
    };

    return {
      perimeter,
      cyan: createLedSet(Math.max(9, aperture.width * .14)),
      magenta: createLedSet(Math.max(6, aperture.width * .09))
    };
  }

  function appendBunkerAperturePath(target, aperture, padding = 0) {
    const width = aperture.width + padding * 2;
    const height = aperture.height + padding * 2;
    const cut = clamp(aperture.cut + padding * .18, 8, Math.min(width, height) * .24);
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const left = aperture.x - halfWidth;
    const right = aperture.x + halfWidth;
    const top = aperture.y - halfHeight;
    const bottom = aperture.y + halfHeight;
    target.moveTo(left + cut, top);
    target.lineTo(right - cut, top);
    target.lineTo(right, top + cut);
    target.lineTo(right, bottom - cut);
    target.lineTo(right - cut, bottom);
    target.lineTo(left + cut, bottom);
    target.lineTo(left, bottom - cut);
    target.lineTo(left, top + cut);
    target.closePath();
  }

  function drawBunkerAperturePath(target, aperture, padding = 0) {
    target.beginPath();
    appendBunkerAperturePath(target, aperture, padding);
  }

  function drawHexBolt(target, x, y, radius, alpha = .48) {
    target.save();
    target.globalAlpha = alpha;
    target.fillStyle = '#11161a';
    target.strokeStyle = 'rgba(179, 191, 191, .48)';
    target.lineWidth = 1;
    target.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const angle = -Math.PI / 6 + i * Math.PI / 3;
      const pointX = x + Math.cos(angle) * radius;
      const pointY = y + Math.sin(angle) * radius;
      if (i === 0) target.moveTo(pointX, pointY);
      else target.lineTo(pointX, pointY);
    }
    target.closePath();
    target.fill();
    target.stroke();
    target.restore();
  }

  function drawBunkerBarcode(target, x, y, width, height, seed) {
    target.save();
    target.fillStyle = 'rgba(6, 11, 14, .74)';
    target.strokeStyle = 'rgba(104, 179, 186, .42)';
    target.lineWidth = 1;
    target.fillRect(x, y, width, height);
    target.strokeRect(x, y, width, height);
    let cursor = x + 4;
    let index = 0;
    while (cursor < x + width - 4) {
      const bar = 1 + Math.round(((hashNoise(seed + index * 3.17) + 1) / 2) * 3);
      target.fillStyle = index % 3 === 0 ? 'rgba(0, 240, 255, .72)' : 'rgba(198, 44, 255, .48)';
      target.fillRect(cursor, y + 3, bar, height - 6);
      cursor += bar + 2 + Math.round(((hashNoise(seed + index * 7.11) + 1) / 2) * 2);
      index += 1;
    }
    target.restore();
  }

  function drawBunkerWallText(target, text, x, y, align = 'left', alpha = .46) {
    const size = clamp(Math.min(viewport.width, viewport.height) * .012, 7, 11);
    target.save();
    target.font = `${size}px ${FONT_STACK}`;
    target.letterSpacing = '0.12em';
    target.textAlign = align;
    target.textBaseline = 'middle';
    target.fillStyle = `rgba(210, 221, 215, ${alpha})`;
    target.shadowColor = 'rgba(0, 240, 255, .16)';
    target.shadowBlur = 4;
    target.fillText(text, x, y);
    target.restore();
  }

  function drawBunkerWallSurface(target) {
    const width = viewport.width;
    const height = viewport.height;
    const panelPitch = 240;
    const base = target.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, '#3a3d3e');
    base.addColorStop(.42, '#252a2d');
    base.addColorStop(1, '#171d21');
    target.fillStyle = base;
    target.fillRect(0, 0, width, height);

    const steelTop = target.createLinearGradient(0, 0, 0, height * .11);
    steelTop.addColorStop(0, 'rgba(157, 165, 161, .22)');
    steelTop.addColorStop(1, 'rgba(13, 18, 22, .06)');
    target.fillStyle = steelTop;
    target.fillRect(0, 0, width, height * .11);
    target.fillStyle = 'rgba(6, 10, 13, .28)';
    target.fillRect(0, height * .89, width, height * .11);

    const wallTexture = target.createPattern(bunkerWallTextureCanvas, 'repeat');
    if (wallTexture) {
      target.save();
      target.fillStyle = wallTexture;
      target.fillRect(0, 0, width, height);
      target.restore();
    }

    target.save();
    target.lineWidth = 1;
    target.strokeStyle = 'rgba(4, 8, 11, .48)';
    for (let x = panelPitch; x < width; x += panelPitch) {
      target.beginPath();
      target.moveTo(x, 0);
      target.lineTo(x, height);
      target.stroke();
    }
    for (let y = panelPitch; y < height; y += panelPitch) {
      target.beginPath();
      target.moveTo(0, y);
      target.lineTo(width, y);
      target.stroke();
    }
    target.strokeStyle = 'rgba(193, 204, 198, .11)';
    target.beginPath();
    target.moveTo(width * .035, height * .075);
    target.lineTo(width * .965, height * .075);
    target.moveTo(width * .035, height * .925);
    target.lineTo(width * .965, height * .925);
    target.stroke();
    target.restore();

    const edgeGradient = target.createLinearGradient(0, 0, width, 0);
    edgeGradient.addColorStop(0, 'rgba(5, 9, 12, .65)');
    edgeGradient.addColorStop(.06, 'rgba(137, 150, 148, .16)');
    edgeGradient.addColorStop(.94, 'rgba(137, 150, 148, .16)');
    edgeGradient.addColorStop(1, 'rgba(5, 9, 12, .65)');
    target.fillStyle = edgeGradient;
    target.fillRect(0, height * .03, width, height * .035);
    target.fillRect(0, height * .935, width, height * .035);

    for (const mini of app.minis) {
      const aperture = mini.aperture;
      const plateBounds = getApertureOuterBounds(aperture);
      const plateLeft = plateBounds.left;
      const plateTop = plateBounds.top;
      const plateWidth = plateBounds.width;
      const plateHeight = plateBounds.height;
      target.strokeStyle = 'rgba(206, 214, 207, .13)';
      target.lineWidth = 1;
      target.strokeRect(plateLeft, plateTop, plateWidth, plateHeight);
      target.strokeStyle = 'rgba(3, 8, 11, .52)';
      target.strokeRect(plateLeft + 4, plateTop + 4, plateWidth - 8, plateHeight - 8);
      drawHexBolt(target, plateLeft + 8, plateTop + 8, 3.5, .54);
      drawHexBolt(target, plateLeft + plateWidth - 8, plateTop + 8, 3.5, .54);
      drawHexBolt(target, plateLeft + 8, plateTop + plateHeight - 8, 3.5, .54);
      drawHexBolt(target, plateLeft + plateWidth - 8, plateTop + plateHeight - 8, 3.5, .54);
    }

    target.save();
    target.lineCap = 'round';
    target.strokeStyle = 'rgba(0, 0, 0, .58)';
    target.lineWidth = 7;
    target.beginPath();
    target.moveTo(width * .025, height * .18);
    target.lineTo(width * .025, height * .82);
    target.lineTo(width * .08, height * .86);
    target.moveTo(width * .975, height * .86);
    target.lineTo(width * .975, height * .18);
    target.lineTo(width * .92, height * .14);
    target.stroke();
    target.strokeStyle = 'rgba(102, 145, 148, .38)';
    target.lineWidth = 2;
    target.stroke();
    target.strokeStyle = 'rgba(0, 240, 255, .62)';
    target.lineWidth = 1.5;
    target.shadowColor = 'rgba(0, 240, 255, .9)';
    target.shadowBlur = 10;
    target.stroke();
    target.restore();

    const boltRadius = clamp(Math.min(width, height) * .006, 3, 5);
    const edgeInset = clamp(Math.min(width, height) * .026, 16, 30);
    let lastBoltX = edgeInset - panelPitch;
    for (let x = edgeInset; x <= width - edgeInset; x += panelPitch) {
      drawHexBolt(target, x, edgeInset, boltRadius, .56);
      drawHexBolt(target, x, height - edgeInset, boltRadius, .56);
      lastBoltX = x;
    }
    if (width - edgeInset - lastBoltX > panelPitch * .42) {
      const x = width - edgeInset;
      drawHexBolt(target, x, edgeInset, boltRadius, .56);
      drawHexBolt(target, x, height - edgeInset, boltRadius, .56);
    }

    const gridLayout = getResponsiveGridLayout();
    drawBunkerWallText(target, 'SECTOR 04-B', width * .045, height * .055);
    drawBunkerWallText(target, 'ARMOR PLATE // T-09', width * .955, height * .055, 'right', .36);
    drawBunkerWallText(target, 'CAUTION: HIGH VOLTAGE', width * .045, height * .955, 'left', .4);
    drawBunkerWallText(target, 'REINFORCED CONCRETE // 4200 PSI', width * .955, height * .955, 'right', .34);
    if (gridLayout.columns === 2) {
      const barcodeWidth = clamp(width * .17, 42, 72);
      const barcodeX = (width - barcodeWidth) / 2;
      drawBunkerBarcode(target, barcodeX, height * .025, barcodeWidth, 18, 17);
      drawBunkerBarcode(target, barcodeX, height * .975 - 18, barcodeWidth, 18, 47);
    } else {
      const barcodeWidth = clamp(width * .085, 54, 105);
      drawBunkerBarcode(target, width * .045, height * .12, barcodeWidth, 24, 17);
      drawBunkerBarcode(target, width * .955 - barcodeWidth, height * .84, barcodeWidth, 24, 47);
    }
    if (gridLayout.columns === 4) {
      const gridOuterWidth = (gridLayout.columns - 1) * gridLayout.pitchX +
        gridLayout.apertureSize + getApertureOuterInset(gridLayout.apertureSize) * 2;
      const gridLeft = (width - gridOuterWidth) / 2;
      const gridRight = gridLeft + gridOuterWidth;
      if (gridLeft > panelPitch * .7) {
        for (let x = panelPitch / 2; x < width - panelPitch / 2; x += panelPitch) {
          if (x < gridLeft - 52 || x > gridRight + 52) {
            drawBunkerWallText(target, 'ARMOR // T-09', x, height * .10, 'center', .24);
          }
        }
      }
    }

    target.save();
    target.globalCompositeOperation = 'lighter';
    target.fillStyle = 'rgba(0, 240, 255, .24)';
    target.shadowColor = 'rgba(0, 240, 255, .98)';
    target.shadowBlur = 15;
    for (let i = 0; i < 12; i += 1) {
      const y = height * (.17 + i * .056);
      const tickWidth = 5 + (i % 3) * 3;
      target.fillRect(width * .035 - 1, y - 1, tickWidth + 2, 4);
      target.fillRect(width * .965 - 7 - (i % 3) * 3, y - 1, tickWidth + 2, 4);
    }
    target.shadowBlur = 5;
    target.fillStyle = 'rgba(177, 255, 255, .96)';
    for (let i = 0; i < 12; i += 1) {
      const y = height * (.17 + i * .056);
      const tickWidth = 5 + (i % 3) * 3;
      target.fillRect(width * .035, y, tickWidth, 2);
      target.fillRect(width * .965 - 8 - (i % 3) * 3, y, tickWidth, 2);
    }
    target.restore();
  }

  function getShutterSeamPoints(aperture) {
    const left = aperture.x - aperture.width / 2;
    const top = aperture.y - aperture.height / 2;
    const stepX = aperture.width / 10;
    // Screen-space profile: the center flat is lower than both outer flats.
    return [
      { x: left, y: top + aperture.height * .5 },
      { x: left + stepX * 2, y: top + aperture.height * .5 },
      { x: left + stepX * 4, y: top + aperture.height * .6 },
      { x: left + stepX * 6, y: top + aperture.height * .6 },
      { x: left + stepX * 8, y: top + aperture.height * .5 },
      { x: left + aperture.width, y: top + aperture.height * .5 }
    ];
  }

  function getShutterKeypadLayout(aperture) {
    const keypadWidth = clamp(aperture.width * .16, 18, 48);
    const keypadHeight = clamp(Math.min(keypadWidth * 1.28, aperture.height * .20), 24, 68);
    const keypadRight = aperture.x + aperture.width / 2 - aperture.width * .11;
    const keypadLeft = keypadRight - keypadWidth;
    const displayHeight = clamp(keypadHeight * .18, 4, 8);
    const seamSafeTop = aperture.y - aperture.height / 2 + aperture.height * .62;
    const requestedTop = aperture.y - aperture.height / 2 + aperture.height * .65;
    const keypadTop = Math.max(requestedTop, seamSafeTop + displayHeight + 6);
    const deviceCenterX = keypadLeft + keypadWidth / 2;
    const displayWidth = keypadWidth + 2;
    const displayLeft = deviceCenterX - displayWidth / 2;
    const displayTop = keypadTop - displayHeight - 6;
    const gap = clamp(Math.min(keypadWidth, keypadHeight) * .07, 1.5, 3);
    const padding = 2;
    return {
      keypadWidth,
      keypadHeight,
      keypadLeft,
      keypadTop,
      displayHeight,
      deviceCenterX,
      displayWidth,
      displayLeft,
      displayTop,
      displayFontSize: clamp(displayHeight * 1.15, 5, 8),
      gap,
      padding,
      keyWidth: (keypadWidth - padding * 2 - gap * 3) / 4,
      keyHeight: (keypadHeight - padding * 2 - gap * 4) / 5
    };
  }

  function drawShutterPolygon(target, aperture, seam, topPanel) {
    const left = aperture.x - aperture.width / 2;
    const right = aperture.x + aperture.width / 2;
    const top = aperture.y - aperture.height / 2;
    const bottom = aperture.y + aperture.height / 2;
    target.beginPath();
    if (topPanel) {
      target.moveTo(left, top);
      target.lineTo(right, top);
      for (let i = seam.length - 1; i >= 0; i -= 1) target.lineTo(seam[i].x, seam[i].y);
    } else {
      target.moveTo(seam[0].x, seam[0].y);
      for (let i = 1; i < seam.length; i += 1) target.lineTo(seam[i].x, seam[i].y);
      target.lineTo(right, bottom);
      target.lineTo(left, bottom);
    }
    target.closePath();
  }

  function drawShutterSlitPath(target, aperture) {
    const width = aperture.width * .67;
    const height = clamp(aperture.height * .10, 7, 16);
    const centerY = aperture.y - aperture.height * .15;
    const left = aperture.x - width / 2;
    const right = aperture.x + width / 2;
    const top = centerY - height / 2;
    const bottom = centerY + height / 2;
    const cut = Math.min(height * .38, width * .08);
    target.beginPath();
    target.moveTo(left + cut, top);
    target.lineTo(right - cut, top);
    target.lineTo(right, centerY);
    target.lineTo(right - cut, bottom);
    target.lineTo(left + cut, bottom);
    target.lineTo(left, centerY);
    target.closePath();
  }

  function getBunkerHazardPattern(target) {
    if (!bunkerHazardPattern) bunkerHazardPattern = target.createPattern(bunkerHazardCanvas, 'repeat');
    return bunkerHazardPattern;
  }

  function drawShutterPanelRaw(target, aperture, seam, bayIndex, topPanel, offsetY) {
    const left = aperture.x - aperture.width / 2;
    const right = aperture.x + aperture.width / 2;
    const top = aperture.y - aperture.height / 2;
    const bottom = aperture.y + aperture.height / 2;
    const radius = clamp(aperture.width * .035, 1.8, 3.5);
    const mini = app.minis[bayIndex];
    const gradientKey = topPanel ? 'top' : 'bottom';
    let gradient = mini.shutterGradients[gradientKey];
    if (!gradient) {
      gradient = topPanel
        ? target.createLinearGradient(0, top, 0, aperture.y)
        : target.createLinearGradient(0, aperture.y, 0, bottom);
      if (topPanel) {
        gradient.addColorStop(0, '#4b5050');
        gradient.addColorStop(.54, '#2d3538');
        gradient.addColorStop(1, '#171e22');
      } else {
        gradient.addColorStop(0, '#20282c');
        gradient.addColorStop(.48, '#30383a');
        gradient.addColorStop(1, '#151b1f');
      }
      mini.shutterGradients[gradientKey] = gradient;
    }

    target.save();
    drawBunkerAperturePath(target, aperture);
    target.clip();
    target.translate(0, offsetY);
    target.fillStyle = gradient;
    drawShutterPolygon(target, aperture, seam, topPanel);
    target.fill();

    target.strokeStyle = 'rgba(211, 220, 213, .17)';
    target.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = topPanel ? top + aperture.height * i * .12 : bottom - aperture.height * i * .12;
      target.beginPath();
      target.moveTo(left + aperture.width * .12, y);
      target.lineTo(right - aperture.width * .12, y);
      target.stroke();
    }

    target.strokeStyle = 'rgba(5, 9, 11, .66)';
    target.lineWidth = 2;
    target.beginPath();
    if (topPanel) {
      target.moveTo(left + aperture.width * .16, top + 4);
      target.lineTo(left + aperture.width * .16, seam[1].y - 6);
      target.moveTo(right - aperture.width * .16, top + 4);
      target.lineTo(right - aperture.width * .16, seam[4].y - 6);
    } else {
      target.moveTo(left + aperture.width * .16, seam[1].y + 6);
      target.lineTo(left + aperture.width * .16, bottom - 4);
      target.moveTo(right - aperture.width * .16, seam[4].y + 6);
      target.lineTo(right - aperture.width * .16, bottom - 4);
    }
    target.stroke();

    const boltY = topPanel ? top + aperture.height * .13 : bottom - aperture.height * .13;
    drawHexBolt(target, left + aperture.width * .18, boltY, radius, .75);
    drawHexBolt(target, right - aperture.width * .18, boltY, radius, .75);
    if (topPanel) {
      drawBunkerWallText(target, `BAY-${String(bayIndex + 1).padStart(2, '0')}`, aperture.x, boltY, 'center', .58);
    }
    target.restore();
  }

  function drawShutterSprite(target, aperture, sprite, offsetY) {
    if (!sprite) return false;
    target.save();
    drawBunkerAperturePath(target, aperture);
    target.clip();
    target.drawImage(
      sprite.canvas,
      sprite.left,
      sprite.top + offsetY,
      sprite.width,
      sprite.height
    );
    target.restore();
    return true;
  }

  function drawShutterPanel(target, aperture, seam, bayIndex, topPanel, offsetY) {
    const mini = app.minis[bayIndex];
    const sprite = mini.shutterSprites?.[topPanel ? 'topPanel' : 'bottomPanel'];
    if (!drawShutterSprite(target, aperture, sprite, offsetY)) {
      drawShutterPanelRaw(target, aperture, seam, bayIndex, topPanel, offsetY);
    }
  }

  function drawIdleShutterKey(target, x, y, width, height) {
    target.fillStyle = 'rgba(27, 36, 39, .98)';
    target.strokeStyle = 'rgba(104, 135, 135, .58)';
    target.shadowColor = 'rgba(0, 0, 0, .4)';
    target.shadowBlur = 1.5;
    target.fillRect(x, y, width, height);
    target.strokeRect(x, y, width, height);
  }

  function drawShutterKeypadBaseRaw(target, aperture, offsetY, layout) {
    const {
      keypadWidth,
      keypadHeight,
      keypadLeft,
      keypadTop
    } = layout;

    target.save();
    drawBunkerAperturePath(target, aperture);
    target.clip();
    target.translate(0, offsetY);
    target.fillStyle = 'rgba(6, 12, 15, .9)';
    target.strokeStyle = 'rgba(123, 161, 160, .5)';
    target.lineWidth = 1;
    target.fillRect(keypadLeft, keypadTop, keypadWidth, keypadHeight);
    target.strokeRect(keypadLeft, keypadTop, keypadWidth, keypadHeight);
    target.restore();
  }

  function drawShutterKeypad(target, aperture, state, offsetY, time, layout, bayIndex) {
    const {
      keypadLeft,
      keypadTop,
      displayHeight,
      deviceCenterX,
      displayWidth,
      displayLeft,
      displayTop,
      displayFontSize,
      gap,
      padding,
      keyWidth,
      keyHeight
    } = layout;
    const shutterSprites = app.minis[bayIndex]?.shutterSprites;
    const sprite = shutterSprites?.keypad;
    const keySprite = shutterSprites?.key;
    const keyRow = shutterSprites?.keyRow;
    if (!drawShutterSprite(target, aperture, sprite, offsetY)) {
      drawShutterKeypadBaseRaw(target, aperture, offsetY, layout);
    }
    const enteredCount = getKeypadEnteredCount(state, time);
    const elapsed = state?.isOpening ? time - state.openingStartedAt : -1;
    let activeKeyIndex = -1;
    let activePressAmount = 0;
    if (state?.isOpening) {
      for (const entry of state.keypadSequence) {
        const progress = (elapsed - entry.start) / entry.duration;
        if (progress <= 0 || progress >= 1) continue;
        activeKeyIndex = entry.keyIndex;
        activePressAmount = Math.sin(Math.PI * progress);
        break;
      }
    }
    const displayResult = elapsed >= BULKHEAD_TIMING.keypadDuration ? state.accessResult : null;
    const displayTone = displayResult === 'granted'
      ? { rgb: '0, 255, 0', color: '#00ff00' }
      : displayResult === 'denied'
        ? { rgb: '255, 0, 0', color: '#ff0000' }
        : null;

    target.save();
    drawBunkerAperturePath(target, aperture);
    target.clip();
    target.translate(0, offsetY);

    target.fillStyle = displayResult === 'granted'
      ? 'rgba(0, 150, 28, .94)'
      : displayResult === 'denied'
        ? 'rgba(150, 0, 0, .94)'
        : 'rgba(3, 10, 13, .96)';
    target.strokeStyle = displayResult === 'granted'
      ? 'rgba(148, 255, 158, .98)'
      : displayResult === 'denied'
        ? 'rgba(255, 150, 150, .98)'
        : 'rgba(118, 177, 180, .72)';
    target.shadowColor = displayTone ? `rgba(${displayTone.rgb}, .95)` : 'transparent';
    target.shadowBlur = displayTone ? 10 : 0;
    target.fillRect(displayLeft, displayTop, displayWidth, displayHeight);
    target.strokeRect(displayLeft, displayTop, displayWidth, displayHeight);
    target.shadowBlur = 0;
    target.strokeStyle = displayTone
      ? `rgba(${displayTone.rgb}, .86)`
      : 'rgba(0, 240, 255, .48)';
    target.beginPath();
    target.moveTo(displayLeft + 1, displayTop + 1);
    target.lineTo(displayLeft + displayWidth - 1, displayTop + 1);
    target.moveTo(displayLeft + 1, displayTop + displayHeight - 1);
    target.lineTo(displayLeft + displayWidth - 1, displayTop + displayHeight - 1);
    target.stroke();
    if (enteredCount > 0) {
      target.font = `${displayFontSize}px ${FONT_STACK}`;
      target.textAlign = 'center';
      target.textBaseline = 'middle';
      target.fillStyle = displayTone ? displayTone.color : '#00ff00';
      target.shadowColor = displayTone ? `rgba(${displayTone.rgb}, .98)` : 'rgba(0, 255, 0, .92)';
      target.shadowBlur = displayTone ? 8 : 5;
      target.fillText('*'.repeat(enteredCount), deviceCenterX, displayTop + displayHeight * .54);
      target.shadowBlur = 0;
    }
    if (displayResult === 'denied' && enteredCount > 0) {
      const strikeProgress = clamp(
        (elapsed - BULKHEAD_TIMING.keypadDuration) / BULKHEAD_TIMING.deniedDisplayDuration,
        0,
        1
      );
      const strikeLeft = displayLeft + 4;
      const strikeRight = strikeLeft + (displayWidth - 8) * strikeProgress;
      const strikeY = displayTop + displayHeight * .54;
      target.beginPath();
      target.moveTo(strikeLeft, strikeY);
      target.lineTo(strikeRight, strikeY);
      target.strokeStyle = '#ff0000';
      target.lineWidth = 2.5;
      target.lineCap = 'round';
      target.shadowColor = 'rgba(255, 0, 0, .98)';
      target.shadowBlur = 9;
      target.stroke();
      target.shadowBlur = 0;
    }
    const scanX = displayLeft + ((time * .0011) % 1) * displayWidth;
    target.strokeStyle = displayTone
      ? `rgba(${displayTone.rgb}, .88)`
      : 'rgba(0, 240, 255, .62)';
    target.lineWidth = 1;
    target.beginPath();
    target.moveTo(scanX, displayTop + 1);
    target.lineTo(scanX, displayTop + displayHeight - 1);
    target.stroke();

    for (let row = 0; row < 5; row += 1) {
      const rowTop = keypadTop + padding + row * (keyHeight + gap);
      if (row !== Math.floor(activeKeyIndex / 4) && keyRow) {
        target.drawImage(
          keyRow.canvas,
          keypadLeft + padding - keyRow.padding,
          rowTop - keyRow.padding,
          keyRow.width,
          keyRow.height
        );
        continue;
      }
      for (let column = 0; column < 4; column += 1) {
        const keyIndex = row * 4 + column;
        const pressAmount = keyIndex === activeKeyIndex ? activePressAmount : 0;
        const x = keypadLeft + padding + column * (keyWidth + gap);
        const baseY = rowTop;
        if (pressAmount <= 0 && keySprite) {
          target.drawImage(
            keySprite.canvas,
            x - keySprite.padding,
            baseY - keySprite.padding,
            keySprite.width,
            keySprite.height
          );
          continue;
        }
        const y = baseY + pressAmount * 1.5;
        target.save();
        target.fillStyle = pressAmount > 0
          ? 'rgba(0, 255, 102, .58)'
          : 'rgba(27, 36, 39, .98)';
        target.strokeStyle = pressAmount > 0
          ? 'rgba(164, 255, 190, .9)'
          : 'rgba(104, 135, 135, .58)';
        target.shadowColor = pressAmount > 0 ? 'rgba(0, 255, 102, .85)' : 'rgba(0, 0, 0, .4)';
        target.shadowBlur = pressAmount > 0 ? 6 : 1.5;
        target.fillRect(x, y, keyWidth, keyHeight);
        target.strokeRect(x, y, keyWidth, keyHeight);
        target.restore();
      }
    }
    target.restore();
  }

  function drawShutterSlit(target, aperture, offsetY, feedback) {
    const intensity = feedback.intensity;
    target.save();
    drawBunkerAperturePath(target, aperture);
    target.clip();
    target.translate(0, offsetY);
    target.globalCompositeOperation = 'destination-out';
    drawShutterSlitPath(target, aperture);
    target.fill();
    target.globalCompositeOperation = 'source-over';
    if (intensity > 0) {
      target.fillStyle = `rgba(${feedback.rgb}, ${.14 + intensity * .28})`;
      target.shadowColor = `rgba(${feedback.rgb}, .96)`;
      target.shadowBlur = 12 + intensity * 14;
      drawShutterSlitPath(target, aperture);
      target.fill();
      target.shadowBlur = 0;
    }
    drawShutterSlitPath(target, aperture);
    target.strokeStyle = 'rgba(4, 9, 12, .96)';
    target.lineWidth = 4;
    target.stroke();
    target.strokeStyle = intensity > 0
      ? `rgba(${feedback.rgb}, .98)`
      : 'rgba(0, 240, 255, .42)';
    target.lineWidth = intensity > 0 ? 1.5 : 1;
    target.shadowColor = intensity > 0 ? `rgba(${feedback.rgb}, .98)` : 'rgba(0, 240, 255, .42)';
    target.shadowBlur = intensity > 0 ? 12 + intensity * 6 : 6;
    target.stroke();
    target.restore();
  }

  function drawShutterSeam(target, aperture, seam, offsetY) {
    target.save();
    drawBunkerAperturePath(target, aperture);
    target.clip();
    target.translate(0, offsetY);
    target.lineCap = 'butt';
    target.lineJoin = 'bevel';
    target.beginPath();
    target.moveTo(seam[0].x, seam[0].y);
    for (let i = 1; i < seam.length; i += 1) target.lineTo(seam[i].x, seam[i].y);
    target.strokeStyle = 'rgba(4, 7, 9, .96)';
    target.lineWidth = clamp(aperture.width * .085, 7, 13);
    target.stroke();
    target.strokeStyle = getBunkerHazardPattern(target) || '#e0a328';
    target.lineWidth = clamp(aperture.width * .064, 5, 10);
    target.stroke();
    target.strokeStyle = 'rgba(238, 245, 224, .44)';
    target.lineWidth = 1;
    target.stroke();
    target.restore();
  }

  function drawApertureShutters(
    target,
    aperture,
    bayIndex,
    openingProgress = 0,
    feedback = NO_BULKHEAD_FEEDBACK,
    time = 0,
    state = bulkheadState.bays[bayIndex]
  ) {
    const mini = app.minis[bayIndex];
    const seam = mini.shutterSeam;
    const travel = (aperture.height + 26) * easeInOutCubic(openingProgress);
    const topOffset = -travel;
    const bottomOffset = travel;

    drawShutterPanel(target, aperture, seam, bayIndex, true, topOffset);
    drawShutterPanel(target, aperture, seam, bayIndex, false, bottomOffset);
    drawShutterKeypad(target, aperture, state, bottomOffset, time, mini.keypadLayout, bayIndex);
    drawShutterSlit(target, aperture, topOffset, feedback);
    drawShutterSeam(target, aperture, seam, topOffset);
    drawShutterSeam(target, aperture, seam, bottomOffset);
  }

  function createShutterSprite(bounds, draw) {
    const dpr = viewport.dpr;
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = Math.max(1, Math.ceil(bounds.width * dpr));
    spriteCanvas.height = Math.max(1, Math.ceil(bounds.height * dpr));
    const spriteContext = spriteCanvas.getContext('2d');
    spriteContext.setTransform(dpr, 0, 0, dpr, -bounds.left * dpr, -bounds.top * dpr);
    draw(spriteContext);
    return { canvas: spriteCanvas, ...bounds };
  }

  function rebuildShutterSprites() {
    for (const mini of app.minis) {
      const aperture = mini.aperture;
      const left = aperture.x - aperture.width / 2;
      const top = aperture.y - aperture.height / 2;
      const keypad = mini.keypadLayout;
      const topPanelBounds = {
        left,
        top,
        width: aperture.width,
        height: aperture.height * .62
      };
      const bottomPanelBounds = {
        left,
        top: top + aperture.height * .48,
        width: aperture.width,
        height: aperture.height * .52
      };
      const keypadLeft = Math.max(left, keypad.keypadLeft - 9);
      const keypadTop = Math.max(top, keypad.displayTop - 11);
      const keypadRight = Math.min(left + aperture.width, keypad.keypadLeft + keypad.keypadWidth + 9);
      const keypadBottom = Math.min(top + aperture.height, keypad.keypadTop + keypad.keypadHeight + 9);
      const keypadBounds = {
        left: keypadLeft,
        top: keypadTop,
        width: keypadRight - keypadLeft,
        height: keypadBottom - keypadTop
      };
      const keyPadding = 4;
      const firstKeyX = keypad.keypadLeft + keypad.padding;
      const firstKeyY = keypad.keypadTop + keypad.padding;
      const keyBounds = {
        left: firstKeyX - keyPadding,
        top: firstKeyY - keyPadding,
        width: keypad.keyWidth + keyPadding * 2,
        height: keypad.keyHeight + keyPadding * 2
      };

      mini.shutterGradients = { top: null, bottom: null };
      const keySprite = createShutterSprite(keyBounds, (target) => {
        drawIdleShutterKey(target, firstKeyX, firstKeyY, keypad.keyWidth, keypad.keyHeight);
      });
      keySprite.padding = keyPadding;
      const rowBounds = {
        left: firstKeyX - keyPadding,
        top: firstKeyY - keyPadding,
        width: keypad.keyWidth * 4 + keypad.gap * 3 + keyPadding * 2,
        height: keypad.keyHeight + keyPadding * 2
      };
      const keyRow = createShutterSprite(rowBounds, (target) => {
        for (let column = 0; column < 4; column += 1) {
          const x = firstKeyX + column * (keypad.keyWidth + keypad.gap);
          drawIdleShutterKey(target, x, firstKeyY, keypad.keyWidth, keypad.keyHeight);
        }
      });
      keyRow.padding = keyPadding;
      mini.shutterSprites = {
        topPanel: createShutterSprite(topPanelBounds, (target) => {
          drawShutterPanelRaw(target, aperture, mini.shutterSeam, mini.index, true, 0);
        }),
        bottomPanel: createShutterSprite(bottomPanelBounds, (target) => {
          drawShutterPanelRaw(target, aperture, mini.shutterSeam, mini.index, false, 0);
        }),
        keypad: createShutterSprite(keypadBounds, (target) => {
          drawShutterKeypadBaseRaw(target, aperture, 0, keypad);
        }),
        key: keySprite,
        keyRow
      };
    }
  }

  function getBulkheadOpeningProgress(bayIndex, time) {
    const state = bulkheadState.bays[bayIndex];
    if (!state) return 0;
    if (!state.isOpening) return state.isOpened ? 1 : 0;
    if (state.accessResult !== 'granted') return 0;
    const elapsed = time - state.openingStartedAt;
    const slideElapsed = Math.max(
      0,
      elapsed - BULKHEAD_GRANTED_SLIDE_START
    );
    return clamp(slideElapsed / BULKHEAD_TIMING.slideDuration, 0, 1);
  }

  function getBulkheadFeedback(bayIndex, time) {
    const state = bulkheadState.bays[bayIndex];
    if (!state || !state.isOpening) return NO_BULKHEAD_FEEDBACK;
    const elapsed = time - state.openingStartedAt;

    if (state.accessResult === 'granted') {
      const flashElapsed = elapsed - BULKHEAD_TIMING.keypadDuration - BULKHEAD_TIMING.grantedDisplayDuration;
      if (flashElapsed < 0 || flashElapsed >= BULKHEAD_TIMING.unlockDuration) return NO_BULKHEAD_FEEDBACK;
      return {
        tone: 'granted',
        rgb: '0, 255, 0',
        color: '#00ff00',
        intensity: Math.pow(Math.abs(Math.sin(flashElapsed / BULKHEAD_TIMING.unlockDuration * Math.PI * 3)), 8)
      };
    }

    if (state.accessResult === 'denied') {
      const warningElapsed = elapsed - BULKHEAD_DENIED_WARNING_START;
      if (warningElapsed < 0 || elapsed >= BULKHEAD_TIMING.deniedResetDuration) return NO_BULKHEAD_FEEDBACK;
      const intensity = warningElapsed < BULKHEAD_TIMING.deniedWarningDuration
        ? .12 + .88 * Math.pow(Math.abs(Math.sin(warningElapsed / BULKHEAD_TIMING.deniedWarningDuration * Math.PI * 3)), 8)
        : .62;
      return {
        tone: 'denied',
        rgb: '255, 0, 0',
        color: '#ff0000',
        intensity
      };
    }

    return NO_BULKHEAD_FEEDBACK;
  }

  function drawBunkerBay(target, mini, bayState, time, active = false) {
    const aperture = mini.aperture;
    target.save();
    drawBunkerAperturePath(target, aperture, getApertureFramePadding(aperture.width));
    target.fillStyle = active ? 'rgba(9, 24, 28, .98)' : 'rgba(13, 18, 22, .98)';
    target.strokeStyle = active ? 'rgba(167, 224, 218, .92)' : 'rgba(131, 143, 142, .7)';
    target.lineWidth = active ? 2.4 : 1.5;
    target.shadowColor = active ? 'rgba(0, 240, 255, .78)' : 'rgba(0, 0, 0, .22)';
    target.shadowBlur = active ? 16 : 3;
    target.fill();
    target.stroke();
    target.restore();

    target.save();
    target.globalCompositeOperation = 'destination-out';
    drawBunkerAperturePath(target, aperture);
    target.fill();
    target.restore();

    if (!bayState.isOpened) {
      const resting = bayState === CLOSED_BULKHEAD_STATE;
      drawApertureShutters(
        target,
        aperture,
        mini.index,
        resting ? 0 : getBulkheadOpeningProgress(mini.index, time),
        resting ? NO_BULKHEAD_FEEDBACK : getBulkheadFeedback(mini.index, time),
        time,
        bayState
      );
    }

    target.save();
    drawBunkerAperturePath(target, aperture);
    target.strokeStyle = 'rgba(2, 7, 10, .92)';
    target.lineWidth = 5;
    target.stroke();
    drawBunkerAperturePath(target, aperture, -4);
    target.strokeStyle = active ? 'rgba(0, 240, 255, .98)' : 'rgba(0, 240, 255, .46)';
    target.lineWidth = active ? 2.2 : 1;
    target.shadowColor = active ? 'rgba(0, 240, 255, .9)' : 'rgba(0, 240, 255, .28)';
    target.shadowBlur = active ? 14 : 4;
    target.stroke();
    target.strokeStyle = active ? 'rgba(198, 44, 255, .8)' : 'rgba(198, 44, 255, .28)';
    target.lineWidth = active ? 1.2 : .7;
    drawBunkerAperturePath(target, aperture, 7);
    target.stroke();
    target.restore();
  }

  function getBunkerBayRenderBounds(aperture) {
    const outer = getApertureOuterBounds(aperture);
    const effectPadding = 18;
    const left = Math.max(0, Math.floor(outer.left - effectPadding));
    const top = Math.max(0, Math.floor(outer.top - effectPadding));
    const right = Math.min(viewport.width, Math.ceil(outer.left + outer.width + effectPadding));
    const bottom = Math.min(viewport.height, Math.ceil(outer.top + outer.height + effectPadding));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function boundsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function rebuildBunkerWallRestingCache(time = performance.now()) {
    const target = bunkerWallRestingCacheCtx;
    const width = viewport.width;
    const height = viewport.height;
    target.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    target.clearRect(0, 0, width, height);
    target.globalCompositeOperation = 'source-over';
    target.drawImage(bunkerWallCacheCanvas, 0, 0, width, height);
    for (const mini of app.minis) {
      drawBunkerBay(target, mini, CLOSED_BULKHEAD_STATE, time, false);
    }
  }

  function getBunkerWallVisualState(mini) {
    const bayState = bulkheadState.bays[mini.index];
    const active = app.wallHoveredIndex === mini.index && !bayState.isOpened && !bayState.isOpening;
    const mode = bayState.isOpening ? 'opening' : bayState.isOpened ? 'opened' : 'closed';
    return `${mode}:${active ? 1 : 0}`;
  }

  function copyBunkerRegion(target, source, bounds, clearFirst = false) {
    const dpr = viewport.dpr;
    if (clearFirst) target.clearRect(bounds.left, bounds.top, bounds.width, bounds.height);
    target.drawImage(
      source,
      bounds.left * dpr,
      bounds.top * dpr,
      bounds.width * dpr,
      bounds.height * dpr,
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height
    );
  }

  function drawBunkerWall(time = performance.now()) {
    if (!bunkerWallCacheReady) return;
    const width = viewport.width;
    const height = viewport.height;
    const dpr = viewport.dpr;
    const target = bunkerWallCtx;
    target.setTransform(dpr, 0, 0, dpr, 0, 0);
    target.globalCompositeOperation = 'source-over';

    const currentVisualStates = app.minis.map(getBunkerWallVisualState);
    const dirtyMinis = bunkerWallInitialized
      ? app.minis.filter((mini) => {
        const bayState = bulkheadState.bays[mini.index];
        return bayState.isOpening || currentVisualStates[mini.index] !== bunkerWallVisualStates[mini.index];
      })
      : app.minis.slice();
    if (!dirtyMinis.length) return;

    const dirtyBounds = bunkerWallInitialized
      ? dirtyMinis.map((mini) => mini.bunkerRenderBounds)
      : [{ left: 0, top: 0, right: width, bottom: height, width, height }];

    if (!bunkerWallInitialized) {
      target.globalCompositeOperation = 'copy';
      target.drawImage(bunkerWallRestingCacheCanvas, 0, 0, width, height);
      target.globalCompositeOperation = 'source-over';
    } else {
      for (const bounds of dirtyBounds) {
        copyBunkerRegion(target, bunkerWallRestingCacheCanvas, bounds, true);
      }
    }

    const changedMinis = app.minis.filter((mini) => {
      const bayState = bulkheadState.bays[mini.index];
      const active = app.wallHoveredIndex === mini.index && !bayState.isOpened && !bayState.isOpening;
      return (active || bayState.isOpened || bayState.isOpening) &&
        dirtyBounds.some((bounds) => boundsIntersect(bounds, mini.bunkerRenderBounds));
    });
    const changedBounds = changedMinis.map((mini) => mini.bunkerRenderBounds);
    if (changedBounds.length) {
      target.save();
      target.beginPath();
      for (const bounds of dirtyBounds) {
        target.rect(bounds.left, bounds.top, bounds.width, bounds.height);
      }
      target.clip();
      for (const bounds of changedBounds) copyBunkerRegion(target, bunkerWallCacheCanvas, bounds);
      for (const mini of app.minis) {
        const renderBounds = mini.bunkerRenderBounds;
        if (!changedBounds.some((bounds) => boundsIntersect(bounds, renderBounds))) continue;
        const bayState = bulkheadState.bays[mini.index];
        const active = app.wallHoveredIndex === mini.index && !bayState.isOpened && !bayState.isOpening;
        drawBunkerBay(target, mini, bayState, time, active);
      }
      target.restore();
    }

    bunkerWallVisualStates = currentVisualStates;
    bunkerWallInitialized = true;
  }

  function hasPersistentApertureFx(state) {
    return state.isOpened || (state.isOpening && state.accessResult === 'granted');
  }

  function drawBunkerLedFx(time = performance.now()) {
    const target = bunkerFxCtx;
    const activeMinis = app.minis.filter((mini) => {
      const bayState = bulkheadState.bays[mini.index];
      const persistent = hasPersistentApertureFx(bayState);
      const pulseActive = !persistent && !bayState.isOpening &&
        mini.index === app.wallHoveredIndex && time < bayState.wallPulseUntil;
      return persistent || pulseActive;
    });

    target.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    for (const bounds of bunkerFxDirtyBounds) {
      target.clearRect(bounds.left, bounds.top, bounds.width, bounds.height);
    }
    bunkerFxDirtyBounds = activeMinis.map((mini) => mini.bunkerRenderBounds);
    bunkerFxVisible = activeMinis.length > 0;
    if (!bunkerFxVisible) return;

    for (const mini of activeMinis) {
      const aperture = mini.aperture;
      const fxGeometry = mini.apertureFxGeometry;
      if (!fxGeometry) continue;
      const cyanTravel = ((time * .00072 + mini.index * .17) * 140) % fxGeometry.cyan.cycle;
      const magentaTravel = ((time * .00072 + mini.index * .17) * 180 + 36) % fxGeometry.magenta.cycle;
      const breathe = .56 + Math.sin(time * .006 + mini.index * .8) * .22;
      target.save();
      drawBunkerAperturePath(target, aperture, BUNKER_APERTURE_FX_PADDING);
      target.strokeStyle = `rgba(0, 240, 255, ${.24 + breathe * .18})`;
      target.lineWidth = 2;
      target.shadowColor = 'rgba(0, 240, 255, .72)';
      target.shadowBlur = 10;
      target.stroke();
      target.setLineDash(fxGeometry.cyan.dash);
      target.lineDashOffset = -cyanTravel;
      target.strokeStyle = `rgba(0, 240, 255, ${.48 + breathe * .28})`;
      target.lineWidth = 1.5;
      target.shadowBlur = 14;
      target.stroke();
      target.lineDashOffset = -(cyanTravel + fxGeometry.cyan.cycle * .125);
      target.stroke();
      target.setLineDash([]);
      target.lineDashOffset = 0;
      target.strokeStyle = `rgba(198, 44, 255, ${.24 + breathe * .18})`;
      target.lineWidth = 1;
      target.shadowColor = 'rgba(198, 44, 255, .66)';
      target.shadowBlur = 8;
      target.setLineDash(fxGeometry.magenta.dash);
      target.lineDashOffset = -magentaTravel;
      target.stroke();
      target.lineDashOffset = -(magentaTravel + fxGeometry.magenta.cycle * .125);
      target.stroke();
      target.setLineDash([]);
      target.lineDashOffset = 0;
      target.restore();
    }
  }

  function resizeBunkerFx() {
    const width = viewport.width;
    const height = viewport.height;
    const dpr = viewport.dpr;
    bunkerFxCanvas.width = Math.round(width * dpr);
    bunkerFxCanvas.height = Math.round(height * dpr);
    bunkerFxVisible = false;
    bunkerFxDirtyBounds = [];
    bunkerFxCanvas.style.width = `${width}px`;
    bunkerFxCanvas.style.height = `${height}px`;
    bunkerFxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBunkerLedFx();
  }

  function resizeBunkerWall() {
    const width = viewport.width;
    const height = viewport.height;
    const dpr = viewport.dpr;
    bunkerWallCanvas.width = Math.round(width * dpr);
    bunkerWallCanvas.height = Math.round(height * dpr);
    bunkerHazardPattern = null;
    bunkerWallCanvas.style.width = `${width}px`;
    bunkerWallCanvas.style.height = `${height}px`;
    bunkerWallCacheCanvas.width = Math.round(width * dpr);
    bunkerWallCacheCanvas.height = Math.round(height * dpr);
    bunkerWallRestingCacheCanvas.width = Math.round(width * dpr);
    bunkerWallRestingCacheCanvas.height = Math.round(height * dpr);
    bunkerWallCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bunkerWallCacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bunkerWallRestingCacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bunkerWallCacheReady = true;
    bunkerWallInitialized = false;
    bunkerWallVisualStates = [];
    bunkerWallCacheCtx.clearRect(0, 0, width, height);
    drawBunkerWallSurface(bunkerWallCacheCtx);
    rebuildShutterSprites();
    rebuildBunkerWallRestingCache();
    drawBunkerWall();
    resizeBunkerFx();
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
      vertices: [0, 1, 5, 4]
    },
    {
      id: 'top',
      normal: vec(0, 1, 0),
      vertices: [3, 7, 6, 2]
    },
    {
      id: 'front',
      normal: vec(0, 0, 1),
      vertices: [4, 5, 6, 7]
    },
    {
      id: 'back',
      normal: vec(0, 0, -1),
      vertices: [1, 0, 3, 2]
    },
    {
      id: 'right',
      normal: vec(1, 0, 0),
      vertices: [1, 5, 6, 2]
    },
    {
      id: 'left',
      normal: vec(-1, 0, 0),
      vertices: [0, 3, 7, 4]
    }
  ];

  function createCubeRenderGeometry(includeFaces = true) {
    const worldVertices = cubeVertices.map(() => vec());
    const projectedVertices = cubeVertices.map(() => ({ x: 0, y: 0 }));
    if (!includeFaces) return { worldVertices, projectedVertices };

    const faceItems = faceDefs.map((face) => ({
      face,
      points: face.vertices.map((index) => projectedVertices[index]),
      facing: 0,
      depth: 0
    }));
    const projectedFaces = faceItems.slice();
    const bounds = { left: 0, right: 0, top: 0, bottom: 0 };
    return {
      worldVertices,
      projectedVertices,
      faceItems,
      projectedFaces,
      bounds,
      hit: { faces: projectedFaces, bounds }
    };
  }

  const wireRenderGeometry = createCubeRenderGeometry(false);

  function transformedVertices(cube, options, rotation, target) {
    const vertexJitter = options.vertexJitter || 0;
    const seed = options.seed || 0;
    for (let index = 0; index < cubeVertices.length; index += 1) {
      const vertex = cubeVertices[index];
      let x = vertex.x * cube.half;
      let y = vertex.y * cube.half;
      let z = vertex.z * cube.half;
      if (vertexJitter) {
        x += hashNoise(seed + index * 17.11) * vertexJitter;
        y += hashNoise(seed + index * 29.37 + 11) * vertexJitter;
        z += hashNoise(seed + index * 43.73 + 23) * vertexJitter;
      }

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

      target[index].x = cube.position.x + x;
      target[index].y = cube.position.y + y;
      target[index].z = cube.position.z + z;
    }
    return target;
  }

  function projectVertices(worldVertices, options, target) {
    for (let index = 0; index < worldVertices.length; index += 1) {
      const world = worldVertices[index];
      const depth = Math.max(.8, CAMERA_Z - world.z);
      const perspective = CAMERA_FOCAL / depth;
      target[index].x = viewport.centerX + world.x * viewport.scale * perspective + options.offsetX;
      target[index].y = viewport.centerY - world.y * viewport.scale * perspective + options.offsetY;
    }
    return target;
  }

  function updateBounds(points, bounds) {
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
    bounds.left = left;
    bounds.right = right;
    bounds.top = top;
    bounds.bottom = bottom;
  }

  function createWebGL2Renderer(gl) {
    const GEOMETRY_STRIDE = 6;
    const POINT_STRIDE = 7;
    const colorCache = new Map();

    const compileShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error';
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    };

    const createProgram = (vertexSource, fragmentSource) => {
      const program = gl.createProgram();
      const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
      const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || 'Unknown shader link error';
        gl.deleteProgram(program);
        throw new Error(message);
      }
      return program;
    };

    const positionVertexShader = `#version 300 es
      layout(location = 0) in vec2 a_position;
      uniform vec2 u_resolution;
      void main() {
        vec2 clip = a_position / u_resolution * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      }
    `;
    const backgroundFragmentShader = `#version 300 es
      precision mediump float;
      uniform vec2 u_pixelResolution;
      out vec4 outColor;

      float radialAlpha(float distanceRatio, float middle, float innerAlpha, float middleAlpha) {
        float inner = mix(innerAlpha, middleAlpha, smoothstep(0.0, middle, distanceRatio));
        return mix(inner, 0.0, smoothstep(middle, 1.0, distanceRatio));
      }

      void main() {
        vec2 pixel = vec2(gl_FragCoord.x, u_pixelResolution.y - gl_FragCoord.y);
        vec2 uv = pixel / u_pixelResolution;
        float largestSide = max(u_pixelResolution.x, u_pixelResolution.y);
        vec3 color = vec3(5.0, 5.0, 14.0) / 255.0;

        float cyanDistance = length(pixel - u_pixelResolution * vec2(0.28, 0.30)) / (largestSide * 0.66);
        float cyanAlpha = radialAlpha(cyanDistance, 0.34, 0.13, 0.05);
        color = mix(color, vec3(0.0, 0.78, 0.92), cyanAlpha);

        float purpleDistance = length(pixel - u_pixelResolution * vec2(0.74, 0.70)) / (largestSide * 0.70);
        float purpleAlpha = radialAlpha(purpleDistance, 0.38, 0.12, 0.055);
        color = mix(color, vec3(0.55, 0.08, 0.82), purpleAlpha);

        float horizonProgress = clamp((uv.y - 0.33) / 0.67, 0.0, 1.0);
        float horizonAlpha = horizonProgress < 0.54
          ? mix(0.0, 0.012, horizonProgress / 0.54)
          : mix(0.012, 0.028, (horizonProgress - 0.54) / 0.46);
        vec3 horizonColor = horizonProgress < 0.54
          ? vec3(0.47, 0.16, 0.79)
          : vec3(0.0, 0.94, 1.0);
        color = mix(color, horizonColor, horizonAlpha);

        float centerDistance = length(pixel - u_pixelResolution * 0.5);
        float ringWidth = max(1.0, largestSide / 1200.0);
        float ringOne = 1.0 - smoothstep(ringWidth, ringWidth * 2.0,
          abs(centerDistance - min(u_pixelResolution.x, u_pixelResolution.y) * 0.27));
        float ringTwo = 1.0 - smoothstep(ringWidth, ringWidth * 2.0,
          abs(centerDistance - min(u_pixelResolution.x, u_pixelResolution.y) * 0.36));
        color = mix(color, vec3(0.0, 0.94, 1.0), ringOne * 0.045);
        color = mix(color, vec3(0.74, 0.0, 1.0), ringTwo * 0.035);
        outColor = vec4(color, 1.0);
      }
    `;
    const geometryVertexShader = `#version 300 es
      layout(location = 0) in vec2 a_position;
      layout(location = 1) in vec4 a_color;
      uniform vec2 u_resolution;
      out vec4 v_color;
      void main() {
        vec2 clip = a_position / u_resolution * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        v_color = a_color;
      }
    `;
    const geometryFragmentShader = `#version 300 es
      precision mediump float;
      in vec4 v_color;
      out vec4 outColor;
      void main() { outColor = v_color; }
    `;
    const pointVertexShader = `#version 300 es
      layout(location = 0) in vec2 a_position;
      layout(location = 1) in vec4 a_color;
      layout(location = 2) in float a_size;
      uniform vec2 u_resolution;
      uniform float u_dpr;
      out vec4 v_color;
      void main() {
        vec2 clip = a_position / u_resolution * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        gl_PointSize = max(1.0, a_size * u_dpr);
        v_color = a_color;
      }
    `;
    const pointFragmentShader = `#version 300 es
      precision mediump float;
      in vec4 v_color;
      out vec4 outColor;
      void main() {
        float distanceFromCenter = length(gl_PointCoord - vec2(0.5));
        float coverage = 1.0 - smoothstep(0.38, 0.5, distanceFromCenter);
        if (coverage <= 0.0) discard;
        outColor = vec4(v_color.rgb, v_color.a * coverage);
      }
    `;
    const backgroundProgram = createProgram(positionVertexShader, backgroundFragmentShader);
    const geometryProgram = createProgram(geometryVertexShader, geometryFragmentShader);
    const pointProgram = createProgram(pointVertexShader, pointFragmentShader);
    const apertureBuffer = gl.createBuffer();
    const geometryBuffer = gl.createBuffer();
    const pointBuffer = gl.createBuffer();
    let apertureVertexCount = 0;
    const dynamicBufferCapacities = new Map();

    const createFloatBuilder = (initialCapacity) => ({
      data: new Float32Array(initialCapacity),
      length: 0,
      reset() {
        this.length = 0;
      },
      ensure(additionalLength) {
        const requiredLength = this.length + additionalLength;
        if (requiredLength > this.data.length) {
          let nextCapacity = this.data.length;
          while (nextCapacity < requiredLength) nextCapacity *= 2;
          const nextData = new Float32Array(nextCapacity);
          nextData.set(this.data);
          this.data = nextData;
        }
      },
      push() {
        this.ensure(arguments.length);
        for (let index = 0; index < arguments.length; index += 1) {
          this.data[this.length] = arguments[index];
          this.length += 1;
        }
      }
    });
    const starVertices = createFloatBuilder(1024);
    const geometryVertices = createFloatBuilder(65536);

    const uploadDynamicBuffer = (buffer, vertices) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const byteLength = vertices.length * 4;
      let capacity = dynamicBufferCapacities.get(buffer) || 0;
      if (byteLength > capacity) {
        capacity = 1;
        while (capacity < byteLength) capacity *= 2;
        gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
        dynamicBufferCapacities.set(buffer, capacity);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices.data, 0, vertices.length);
    };

    const createVertexArray = (buffer, attributes) => {
      const vertexArray = gl.createVertexArray();
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      for (const attribute of attributes) {
        gl.enableVertexAttribArray(attribute.location);
        gl.vertexAttribPointer(
          attribute.location,
          attribute.size,
          gl.FLOAT,
          false,
          attribute.stride * 4,
          attribute.offset * 4
        );
      }
      gl.bindVertexArray(null);
      return vertexArray;
    };

    const apertureVertexArray = createVertexArray(apertureBuffer, [
      { location: 0, size: 2, stride: 2, offset: 0 }
    ]);
    const geometryVertexArray = createVertexArray(geometryBuffer, [
      { location: 0, size: 2, stride: GEOMETRY_STRIDE, offset: 0 },
      { location: 1, size: 4, stride: GEOMETRY_STRIDE, offset: 2 }
    ]);
    const pointVertexArray = createVertexArray(pointBuffer, [
      { location: 0, size: 2, stride: POINT_STRIDE, offset: 0 },
      { location: 1, size: 4, stride: POINT_STRIDE, offset: 2 },
      { location: 2, size: 1, stride: POINT_STRIDE, offset: 6 }
    ]);
    const resolutionUniforms = new Map([
      [backgroundProgram, gl.getUniformLocation(backgroundProgram, 'u_resolution')],
      [geometryProgram, gl.getUniformLocation(geometryProgram, 'u_resolution')],
      [pointProgram, gl.getUniformLocation(pointProgram, 'u_resolution')]
    ]);
    const backgroundPixelResolutionUniform = gl.getUniformLocation(backgroundProgram, 'u_pixelResolution');
    const pointDprUniform = gl.getUniformLocation(pointProgram, 'u_dpr');

    const getColor = (hex) => {
      if (colorCache.has(hex)) return colorCache.get(hex);
      const value = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : 'ffffff';
      const color = [
        parseInt(value.slice(0, 2), 16) / 255,
        parseInt(value.slice(2, 4), 16) / 255,
        parseInt(value.slice(4, 6), 16) / 255
      ];
      colorCache.set(hex, color);
      return color;
    };

    const pushGeometryXY = (vertices, x, y, color, alpha) => {
      vertices.ensure(GEOMETRY_STRIDE);
      let offset = vertices.length;
      vertices.data[offset] = x;
      vertices.data[offset += 1] = y;
      vertices.data[offset += 1] = color[0];
      vertices.data[offset += 1] = color[1];
      vertices.data[offset += 1] = color[2];
      vertices.data[offset += 1] = clamp(alpha, 0, 1);
      vertices.length += GEOMETRY_STRIDE;
    };

    const pushGeometryVertex = (vertices, point, color, alpha) => {
      pushGeometryXY(vertices, point.x, point.y, color, alpha);
    };

    const appendPolygon = (vertices, points, color, alpha) => {
      for (let index = 1; index < points.length - 1; index += 1) {
        pushGeometryVertex(vertices, points[0], color, alpha);
        pushGeometryVertex(vertices, points[index], color, alpha);
        pushGeometryVertex(vertices, points[index + 1], color, alpha);
      }
    };

    const appendLine = (vertices, from, to, width, color, alpha) => {
      const deltaX = to.x - from.x;
      const deltaY = to.y - from.y;
      const inverseLength = 1 / (Math.sqrt(deltaX * deltaX + deltaY * deltaY) || 1);
      const normalX = -deltaY * inverseLength * width * .5;
      const normalY = deltaX * inverseLength * width * .5;
      const fromPlusX = from.x + normalX;
      const fromPlusY = from.y + normalY;
      const fromMinusX = from.x - normalX;
      const fromMinusY = from.y - normalY;
      const toPlusX = to.x + normalX;
      const toPlusY = to.y + normalY;
      const toMinusX = to.x - normalX;
      const toMinusY = to.y - normalY;
      pushGeometryXY(vertices, fromPlusX, fromPlusY, color, alpha);
      pushGeometryXY(vertices, fromMinusX, fromMinusY, color, alpha);
      pushGeometryXY(vertices, toPlusX, toPlusY, color, alpha);
      pushGeometryXY(vertices, toPlusX, toPlusY, color, alpha);
      pushGeometryXY(vertices, fromMinusX, fromMinusY, color, alpha);
      pushGeometryXY(vertices, toMinusX, toMinusY, color, alpha);
    };

    const appendLineWithGlow = (vertices, from, to, width, color, alpha, glow) => {
      if (glow > .1) {
        appendLine(vertices, from, to, width + glow * 1.8, color, alpha * .055);
        appendLine(vertices, from, to, width + glow * .72, color, alpha * .12);
      }
      appendLine(vertices, from, to, width, color, alpha);
    };

    const appendPath = (vertices, points, width, color, alpha, glow = 0, closed = false) => {
      const segmentCount = closed ? points.length : points.length - 1;
      for (let index = 0; index < segmentCount; index += 1) {
        appendLineWithGlow(
          vertices,
          points[index],
          points[(index + 1) % points.length],
          width,
          color,
          alpha,
          glow
        );
      }
    };

    const appendCube = (vertices, cube, options = {}, rotationCache = null) => {
      const settings = {
        seed: 0,
        vertexJitter: 0,
        offsetX: 0,
        offsetY: 0,
        wireOnly: false,
        edgeColor: EDGE_COLOR,
        edgeAlpha: 1,
        edgeGlow: 1,
        faceOutlineColor: VECTOR_COLOR,
        faceOutlineOpacity: 1,
        faceOutlineAlpha: .28,
        faceOutlineScale: 1,
        faceGlow: 0,
        fillAlpha: 1,
        ...options
      };
      const rotation = rotationCache || createRotationCache(cube.rotation);
      const geometry = settings.wireOnly
        ? wireRenderGeometry
        : cube.renderGeometry || (cube.renderGeometry = createCubeRenderGeometry());
      const worldVertices = transformedVertices(cube, settings, rotation, geometry.worldVertices);
      const projectedVertices = projectVertices(worldVertices, settings, geometry.projectedVertices);
      const edgeColor = getColor(settings.edgeColor);
      const edgeWidth = Math.max(.8, cube.half * 1.35);
      const edgeGlow = (
        settings.edgeColor === EDGE_COLOR ? Math.max(5, cube.half * 5.2) : Math.max(3, cube.half * 3)
      ) * settings.edgeGlow;

      if (settings.wireOnly) {
        for (const [from, to] of cubeEdges) {
          appendLineWithGlow(
            vertices,
            projectedVertices[from],
            projectedVertices[to],
            edgeWidth,
            edgeColor,
            settings.edgeAlpha,
            edgeGlow
          );
        }
        return null;
      }

      const projectedFaces = geometry.projectedFaces;
      for (let index = 0; index < geometry.faceItems.length; index += 1) {
        projectedFaces[index] = geometry.faceItems[index];
      }
      for (const item of projectedFaces) {
        const face = item.face;
        item.facing = getFaceFacing(cube, face.normal, rotation);
        item.depth = face.vertices.reduce((sum, vertexIndex) => sum + worldVertices[vertexIndex].z, 0) /
          face.vertices.length;
      }
      projectedFaces.sort((a, b) => a.depth - b.depth);

      const faceColor = getColor(FACE_COLOR);
      for (const item of projectedFaces) {
        const faceAlpha = settings.fillAlpha * clamp(.13 + Math.max(0, item.facing) * .22, .10, .36);
        appendPolygon(vertices, item.points, faceColor, faceAlpha);
      }

      const outlineColor = getColor(settings.faceOutlineColor);
      for (const item of projectedFaces) {
        const localAlpha = settings.faceOutlineOpacity *
          clamp(.24 + Math.max(0, item.facing) * .76, .2, 1);
        appendPath(
          vertices,
          item.points,
          Math.max(.45, cube.half * .48) * settings.faceOutlineScale,
          outlineColor,
          localAlpha * settings.faceOutlineAlpha,
          settings.faceGlow,
          true
        );
      }

      for (const [from, to] of cubeEdges) {
        appendLineWithGlow(
          vertices,
          projectedVertices[from],
          projectedVertices[to],
          edgeWidth,
          edgeColor,
          settings.edgeAlpha,
          edgeGlow
        );
      }
      updateBounds(projectedVertices, geometry.bounds);
      return geometry.hit;
    };

    const rebuildApertures = () => {
      const vertices = [];
      for (const mini of app.minis) {
        const points = getBunkerAperturePoints(mini.aperture);
        for (let index = 1; index < points.length - 1; index += 1) {
          vertices.push(
            points[0].x, points[0].y,
            points[index].x, points[index].y,
            points[index + 1].x, points[index + 1].y
          );
        }
      }
      apertureVertexCount = vertices.length / 2;
      gl.bindBuffer(gl.ARRAY_BUFFER, apertureBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    };

    const useResolution = (program) => {
      gl.useProgram(program);
      gl.uniform2f(resolutionUniforms.get(program), viewport.width, viewport.height);
    };

    const render = (time, frameSeed) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.enable(gl.STENCIL_TEST);
      gl.clearColor(5 / 255, 5 / 255, 14 / 255, 1);
      gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      gl.bindVertexArray(apertureVertexArray);
      useResolution(backgroundProgram);
      gl.uniform2f(backgroundPixelResolutionUniform, canvas.width, canvas.height);
      gl.colorMask(false, false, false, false);
      gl.stencilMask(0xff);
      gl.stencilFunc(gl.ALWAYS, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      gl.drawArrays(gl.TRIANGLES, 0, apertureVertexCount);
      gl.colorMask(true, true, true, true);
      gl.stencilMask(0x00);
      gl.stencilFunc(gl.EQUAL, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.drawArrays(gl.TRIANGLES, 0, apertureVertexCount);

      starVertices.reset();
      for (const star of viewport.visibleStars) {
        const shimmer = .74 + Math.sin(time * .00045 + star.phase) * .26;
        const isCyan = star.radius > 1;
        starVertices.push(
          star.x * viewport.width,
          star.y * viewport.height,
          isCyan ? 192 / 255 : 1,
          isCyan ? 250 / 255 : 1,
          1,
          star.alpha * shimmer,
          star.radius * 2
        );
      }
      if (starVertices.length) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(pointVertexArray);
        uploadDynamicBuffer(pointBuffer, starVertices);
        useResolution(pointProgram);
        gl.uniform1f(pointDprUniform, viewport.dpr);
        gl.drawArrays(gl.POINTS, 0, starVertices.length / POINT_STRIDE);
      }

      geometryVertices.reset();
      for (const mini of app.minis) {
        const bayState = bulkheadState.bays[mini.index];
        const hovered = bayState.isOpened && !bayState.isOpening && mini.hovered;
        const feedback = getBulkheadFeedback(mini.index, time);
        const unlockHighlight = feedback.intensity > .02;
        const rotation = createRotationCache(mini.rotation);
        if (glitch.active) {
          appendCube(geometryVertices, mini, {
            wireOnly: true,
            edgeColor: GLITCH_MAGENTA,
            edgeAlpha: .84 * glitch.intensity,
            offsetX: -4.5 * glitch.intensity,
            offsetY: .8 * glitch.intensity,
            vertexJitter: .075 * glitch.intensity,
            seed: frameSeed + mini.index * 9
          }, rotation);
          appendCube(geometryVertices, mini, {
            wireOnly: true,
            edgeColor: GLITCH_CYAN,
            edgeAlpha: .88 * glitch.intensity,
            offsetX: 4.5 * glitch.intensity,
            offsetY: -.8 * glitch.intensity,
            vertexJitter: .07 * glitch.intensity,
            seed: frameSeed + mini.index * 11 + 29
          }, rotation);
        }
        mini.hit = appendCube(geometryVertices, mini, {
          vertexJitter: glitch.active ? .06 * glitch.intensity : 0,
          seed: frameSeed + mini.index,
          edgeAlpha: unlockHighlight ? 1.18 + feedback.intensity * .22 : hovered ? 1.35 : .92,
          edgeColor: unlockHighlight ? feedback.color : hovered ? '#ffffff' : EDGE_COLOR,
          faceOutlineColor: unlockHighlight ? feedback.color : VECTOR_COLOR,
          faceOutlineOpacity: unlockHighlight ? 1.02 + feedback.intensity * .16 : hovered ? 1.18 : .82,
          fillAlpha: unlockHighlight ? 1.02 + feedback.intensity * .14 : hovered ? 1.16 : .88,
        }, rotation);
      }
      if (geometryVertices.length) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(geometryVertexArray);
        uploadDynamicBuffer(geometryBuffer, geometryVertices);
        useResolution(geometryProgram);
        gl.drawArrays(gl.TRIANGLES, 0, geometryVertices.length / GEOMETRY_STRIDE);
      }

      gl.bindVertexArray(null);
      gl.disable(gl.STENCIL_TEST);
    };

    return {
      resize() {
        rebuildApertures();
      },
      render
    };
  }

  let gpuRenderer = null;
  try {
    gpuRenderer = createWebGL2Renderer(gl);
    canvas.dataset.renderer = 'webgl2';
  } catch (error) {
    canvas.dataset.renderer = 'unavailable';
    throw error;
  }

  window.cubusRenderer = Object.freeze({
    get backend() { return canvas.dataset.renderer; }
  });

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    gpuRenderer = null;
    canvas.dataset.renderer = 'restoring';
    if (app.frameRequest) cancelAnimationFrame(app.frameRequest);
    app.frameRequest = 0;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      gpuRenderer = createWebGL2Renderer(gl);
      gpuRenderer.resize();
      canvas.dataset.renderer = 'webgl2';
      app.lastTime = performance.now();
      app.lastFrameAt = 0;
      scheduleAnimationFrame();
    } catch (error) {
      gpuRenderer = null;
      canvas.dataset.renderer = 'unavailable';
      console.error('[CUBUS RENDERER] WebGL2 restoration failed.', error);
    }
  });

  const glitch = {
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
    if (!staticGlitchAudio.unlocked) {
      if (!staticGlitchAudio.warnedAboutAutoplay) {
        console.warn('[CUBUS AUDIO] Static glitch playback is waiting for a user interaction.');
        staticGlitchAudio.warnedAboutAutoplay = true;
      }
      return false;
    }
    const clips = preloadStaticGlitchAudio();
    if (clips.length !== STATIC_GLITCH_SOURCES.length) return false;

    const index = chooseStaticGlitchIndex();
    const clip = clips[index];
    try {
      clip.pause();
      clip.currentTime = 0;
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

  const keypadAudio = {
    context: null,
    unlocked: false,
    warned: false
  };

  function unlockKeypadAudio() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContext !== 'function') {
      if (!keypadAudio.warned) {
        console.warn('[CUBUS AUDIO] Web Audio is unavailable; keypad click cues are disabled.');
        keypadAudio.warned = true;
      }
      return false;
    }
    try {
      if (!keypadAudio.context) keypadAudio.context = new AudioContext();
      if (keypadAudio.context.state === 'suspended') {
        const resume = keypadAudio.context.resume();
        if (resume && typeof resume.catch === 'function') resume.catch(() => {});
      }
      keypadAudio.unlocked = true;
      return true;
    } catch (error) {
      if (!keypadAudio.warned) {
        console.warn('[CUBUS AUDIO] Keypad click cues could not be initialized:', error);
        keypadAudio.warned = true;
      }
      return false;
    }
  }

  function playKeypadClick(keyIndex) {
    const audioContext = keypadAudio.context;
    if (!keypadAudio.unlocked || !audioContext) return false;
    try {
      const start = audioContext.currentTime;
      const pitch = 760 + (keyIndex % 4) * 70;
      const gain = audioContext.createGain();
      const oscillator = audioContext.createOscillator();
      const metallicOscillator = audioContext.createOscillator();
      const metallicGain = audioContext.createGain();

      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(pitch, start);
      oscillator.frequency.exponentialRampToValueAtTime(180, start + .055);
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(.12, start + .002);
      gain.gain.exponentialRampToValueAtTime(.0001, start + .065);

      metallicOscillator.type = 'triangle';
      metallicOscillator.frequency.setValueAtTime(pitch * 2.7, start);
      metallicOscillator.frequency.exponentialRampToValueAtTime(pitch * 1.2, start + .04);
      metallicGain.gain.setValueAtTime(.0001, start);
      metallicGain.gain.exponentialRampToValueAtTime(.045, start + .001);
      metallicGain.gain.exponentialRampToValueAtTime(.0001, start + .045);

      oscillator.connect(gain);
      metallicOscillator.connect(metallicGain);
      gain.connect(audioContext.destination);
      metallicGain.connect(audioContext.destination);
      oscillator.start(start);
      metallicOscillator.start(start);
      oscillator.stop(start + .07);
      metallicOscillator.stop(start + .05);
      return true;
    } catch {
      return false;
    }
  }

  function updateKeypadAudio(state, elapsed) {
    if (elapsed > BULKHEAD_TIMING.keypadDuration) {
      const lastKey = state.keypadSequence[state.keypadSequence.length - 1];
      if (lastKey && !lastKey.played) {
        for (const key of state.keypadSequence) key.played = true;
      }
      return;
    }
    for (const key of state.keypadSequence) {
      if (key.played || elapsed < key.start) continue;
      key.played = true;
      playKeypadClick(key.keyIndex);
    }
  }

  function startGlitch(time) {
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
    hoveredIndex: -1,
    wallHoveredIndex: -1,
    pointerActive: false,
    pointer: { x: -9999, y: -9999 },
    minis: [],
    lastTime: performance.now(),
    lastFrameAt: 0,
    frameRequest: 0
  };

  function resetHoverState() {
    app.hoveredIndex = -1;
    app.wallHoveredIndex = -1;
    for (const mini of app.minis) mini.hovered = false;
    canvas.classList.remove('is-wall-hovered', 'is-cube-hovered');
  }

  function setBulkheadOpened(bayIndex, isOpened = true) {
    if (!Number.isInteger(bayIndex) || !bulkheadState.bays[bayIndex]) return false;
    const state = bulkheadState.bays[bayIndex];
    const nextState = Boolean(isOpened);
    if (state.isOpened === nextState && !state.isOpening) return false;
    state.isOpened = nextState;
    state.isOpening = false;
    state.openingStartedAt = 0;
    state.accessResult = null;
    state.keypadSequence = [];
    state.wallPulseUntil = 0;
    resetHoverState();
    drawBunkerWall();
    drawBunkerLedFx();
    return true;
  }

  function beginBulkheadOpening(bayIndex, time = performance.now()) {
    if (!Number.isInteger(bayIndex) || !bulkheadState.bays[bayIndex]) return false;
    const state = bulkheadState.bays[bayIndex];
    if (state.isOpened || state.isOpening) return false;
    state.isOpening = true;
    state.openingStartedAt = time;
    state.accessResult = isExternalHttpLink(app.minis[bayIndex].href) ? 'granted' : 'denied';
    state.keypadSequence = createKeypadSequence();
    state.wallPulseUntil = 0;
    resetHoverState();
    drawBunkerWall(time);
    drawBunkerLedFx(time);
    return true;
  }

  function updateBulkheadOpening(time) {
    let hasOpening = false;
    for (const state of bulkheadState.bays) {
      if (!state.isOpening) continue;
      hasOpening = true;
      const elapsed = time - state.openingStartedAt;
      updateKeypadAudio(state, elapsed);
      if (state.accessResult === 'granted' && elapsed >= BULKHEAD_TOTAL_DURATION) {
        state.isOpening = false;
        state.isOpened = true;
        state.accessResult = null;
        state.openingStartedAt = 0;
        state.keypadSequence = [];
        state.wallPulseUntil = 0;
      } else if (state.accessResult === 'denied' && elapsed >= BULKHEAD_TIMING.deniedResetDuration) {
        state.isOpening = false;
        state.accessResult = null;
        state.openingStartedAt = 0;
        state.keypadSequence = [];
        state.wallPulseUntil = 0;
      }
    }
    if (hasOpening) drawBunkerWall(time);
  }

  window.cubusBulkhead = Object.freeze({
    get isOpened() { return bulkheadState.bays.every((state) => state.isOpened); },
    get states() {
      return bulkheadState.bays.map((state) => ({
        isOpened: state.isOpened,
        isOpening: state.isOpening
      }));
    },
    setOpened: setBulkheadOpened
  });

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
      href: navItems[index].href,
      position: vec(),
      aperture: null,
      apertureHitPoints: null,
      apertureFxGeometry: null,
      bunkerRenderBounds: null,
      shutterSeam: null,
      keypadLayout: null,
      shutterGradients: { top: null, bottom: null },
      shutterSprites: null,
      renderGeometry: createCubeRenderGeometry(),
      half: 0,
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

  function gridScreenAnchor(column, row, layout = getResponsiveGridLayout()) {
    const x = viewport.centerX + (column - (layout.columns - 1) / 2) * layout.pitchX;
    const y = viewport.centerY + (row - (layout.rows - 1) / 2) * layout.pitchY;
    return { x, y };
  }

  function updateGridTargets() {
    const layout = getResponsiveGridLayout();
    const apertureSize = layout.apertureSize;
    const apertureCut = clamp(apertureSize * .2, 10, 34);
    for (const mini of app.minis) {
      mini.column = mini.index % layout.columns;
      mini.row = Math.floor(mini.index / layout.columns);
      const anchor = gridScreenAnchor(mini.column, mini.row, layout);
      mini.position = screenToWorld(anchor.x, anchor.y, mini.depth);
      mini.aperture = {
        x: anchor.x,
        y: anchor.y,
        width: apertureSize,
        height: apertureSize,
        cut: apertureCut
      };
      // Bound every rotated cube corner to the configured fraction of the frame's outer width.
      const frameSize = apertureSize +
        2 * (getApertureFramePadding(apertureSize) + BUNKER_APERTURE_FRAME_STROKE_HALF);
      mini.half = getMiniCubeHalfForFrame(mini, frameSize);
      mini.apertureHitPoints = getBunkerAperturePoints(mini.aperture, BUNKER_APERTURE_HIT_INSET);
      mini.apertureFxGeometry = createApertureFxGeometry(mini.aperture);
      mini.bunkerRenderBounds = getBunkerBayRenderBounds(mini.aperture);
      mini.shutterSeam = getShutterSeamPoints(mini.aperture);
      mini.keypadLayout = getShutterKeypadLayout(mini.aperture);
      mini.shutterGradients = { top: null, bottom: null };
      mini.shutterSprites = null;
    }
    viewport.visibleStars = viewport.stars.filter((star) => {
      const x = star.x * viewport.width;
      const y = star.y * viewport.height;
      return app.minis.some((mini) => {
        const aperture = mini.aperture;
        return Math.abs(x - aperture.x) <= aperture.width / 2 + star.radius &&
          Math.abs(y - aperture.y) <= aperture.height / 2 + star.radius;
      });
    });
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

  function updateMinis(dt, time) {
    const smoothing = 1 - Math.pow(.002, dt);
    for (const mini of app.minis) {
      let targetVelocityX = mini.velocityTarget.x;
      let targetVelocityY = mini.velocityTarget.y;
      let targetVelocityZ = mini.velocityTarget.z;
      if (mini.rotationBoost) {
        const progress = clamp((time - mini.rotationBoost.startedAt) / mini.rotationBoost.duration, 0, 1);
        const decay = 1 - easeInOutCubic(progress);
        targetVelocityX = lerp(mini.velocityTarget.x, mini.rotationBoost.burstVelocity.x, decay);
        targetVelocityY = lerp(mini.velocityTarget.y, mini.rotationBoost.burstVelocity.y, decay);
        targetVelocityZ = lerp(mini.velocityTarget.z, mini.rotationBoost.burstVelocity.z, decay);
        if (progress >= 1) mini.rotationBoost = null;
      }
      mini.velocity.x = lerp(mini.velocity.x, targetVelocityX, smoothing);
      mini.velocity.y = lerp(mini.velocity.y, targetVelocityY, smoothing);
      mini.velocity.z = lerp(mini.velocity.z, targetVelocityZ, smoothing);
      mini.rotation.x += mini.velocity.x * dt;
      mini.rotation.y += mini.velocity.y * dt;
      mini.rotation.z += mini.velocity.z * dt;
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

  function hitTestCube(point) {
    for (let i = app.minis.length - 1; i >= 0; i -= 1) {
      const bayState = bulkheadState.bays[i];
      if (!bayState.isOpened || bayState.isOpening) continue;
      if (!pointInPolygon(point, app.minis[i].apertureHitPoints)) continue;
      if (cubeIsHit(point, app.minis[i].hit, 6)) return i;
    }
    return -1;
  }

  function hitTestWall(point) {
    for (let i = app.minis.length - 1; i >= 0; i -= 1) {
      const bayState = bulkheadState.bays[i];
      if (bayState.isOpened || bayState.isOpening) continue;
      if (pointInPolygon(point, app.minis[i].apertureHitPoints)) return i;
    }
    return -1;
  }

  function updateHover() {
    const nextWall = app.pointerActive ? hitTestWall(app.pointer) : -1;
    const nextCube = app.pointerActive && nextWall < 0 ? hitTestCube(app.pointer) : -1;
    const previousWall = app.wallHoveredIndex;
    const previousCube = app.hoveredIndex;
    const wallChanged = nextWall !== previousWall;
    const cubeChanged = nextCube !== app.hoveredIndex;
    if (nextWall >= 0 && nextWall !== previousWall) {
      bulkheadState.bays[nextWall].wallPulseUntil = performance.now() + 620;
    }
    app.hoveredIndex = nextCube;
    app.wallHoveredIndex = nextWall;
    if (cubeChanged) {
      if (previousCube >= 0) app.minis[previousCube].hovered = false;
      if (nextCube >= 0) app.minis[nextCube].hovered = true;
    }
    if (wallChanged) canvas.classList.toggle('is-wall-hovered', nextWall >= 0);
    if (cubeChanged) canvas.classList.toggle('is-cube-hovered', nextCube >= 0);
    if (wallChanged) drawBunkerWall();
  }

  function render(time) {
    updateGlitch(time);
    const frameSeed = glitch.active ? glitch.seed + Math.floor(time / 16.6667) : 0;
    gpuRenderer.render(time, frameSeed);
    if (app.pointerActive) updateHover();
  }

  function frame(time) {
    app.frameRequest = 0;
    if (coarsePointerQuery.matches && app.lastFrameAt) {
      const frameElapsed = time - app.lastFrameAt;
      if (frameElapsed < 16) {
        scheduleAnimationFrame();
        return;
      }
      app.lastFrameAt = time - (frameElapsed % 16);
    } else {
      app.lastFrameAt = time;
    }

    const elapsed = Math.min(42, time - app.lastTime);
    const dt = elapsed / 1000;
    app.lastTime = time;

    updateBulkheadOpening(time);
    drawBunkerLedFx(time);
    updateMinis(dt, time);
    render(time);
    scheduleAnimationFrame();
  }

  function scheduleAnimationFrame() {
    if (gpuRenderer && !app.frameRequest && !document.hidden) {
      app.frameRequest = requestAnimationFrame(frame);
    }
  }

  let resizeRequest = 0;
  function scheduleResize() {
    if (resizeRequest) return;
    resizeRequest = requestAnimationFrame(() => {
      resizeRequest = 0;
      resizeCanvas();
    });
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      if (app.frameRequest) cancelAnimationFrame(app.frameRequest);
      app.frameRequest = 0;
      return;
    }
    app.lastTime = performance.now();
    app.lastFrameAt = 0;
    scheduleAnimationFrame();
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function unlockAllAudio() {
    if (!staticGlitchAudio.unlocked) unlockStaticGlitchAudio();
    if (!keypadAudio.context || keypadAudio.context.state !== 'running') unlockKeypadAudio();
  }

  window.addEventListener('pointerdown', unlockAllAudio, { capture: true });
  window.addEventListener('touchstart', unlockAllAudio, { capture: true, passive: true });
  window.addEventListener('keydown', unlockAllAudio, { capture: true });

  canvas.addEventListener('pointermove', (event) => {
    if (!hoverPointerQuery.matches || event.pointerType === 'touch') return;
    app.pointerActive = true;
    app.pointer = pointerPosition(event);
    updateHover();
  });

  canvas.addEventListener('pointerleave', () => {
    app.pointerActive = false;
    app.pointer = { x: -9999, y: -9999 };
    app.hoveredIndex = -1;
    app.wallHoveredIndex = -1;
    for (const state of bulkheadState.bays) state.wallPulseUntil = 0;
    for (const mini of app.minis) mini.hovered = false;
    canvas.classList.remove('is-wall-hovered', 'is-cube-hovered');
    drawBunkerWall();
    drawBunkerLedFx();
  });

  canvas.addEventListener('pointerdown', (event) => {
    const point = pointerPosition(event);
    app.pointerActive = hoverPointerQuery.matches && event.pointerType !== 'touch';
    if (app.pointerActive) app.pointer = point;
    const wallHit = hitTestWall(point);
    if (wallHit >= 0) {
      beginBulkheadOpening(wallHit, performance.now());
      return;
    }
    const hit = hitTestCube(point);
    if (hit >= 0) {
      const destination = app.minis[hit].href;
      window.location.assign(destination);
    }
  });

  canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') canvas.blur();
  });

  window.addEventListener('resize', scheduleResize, { passive: true });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  if (typeof coarsePointerQuery.addEventListener === 'function') {
    coarsePointerQuery.addEventListener('change', scheduleResize);
  }

  buildMinis();
  resizeCanvas();
  scheduleAnimationFrame();
})();
