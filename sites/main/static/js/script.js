(() => {
  'use strict';

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: false });
  const bunkerWallCanvas = document.getElementById('bunker-wall');
  const bunkerWallCtx = bunkerWallCanvas.getContext('2d');
  const bunkerFxCanvas = document.getElementById('bunker-fx');
  const bunkerFxCtx = bunkerFxCanvas.getContext('2d');
  const bunkerWallCacheCanvas = document.createElement('canvas');
  const bunkerWallCacheCtx = bunkerWallCacheCanvas.getContext('2d');
  const bunkerHazardCanvas = document.createElement('canvas');
  const bunkerHazardCtx = bunkerHazardCanvas.getContext('2d');
  let bunkerHazardPattern = null;
  let bunkerFxVisible = false;

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
  const MINI_GRID_HALF = .34 * .85;
  const FACE_ARROW_GAP = .26;
  const FACE_ARROW_REACH = .70;
  const EDGE_COLOR = '#f4ffff';
  const VECTOR_COLOR = '#51f7d1';
  const FACE_COLOR = '#07121a';
  const GLITCH_CYAN = '#00f0ff';
  const GLITCH_MAGENTA = '#ff2bb5';
  const FONT_STACK = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

  const navItems = [
    { label: 'ABOUT',    href: 'https://about.cubus.sh' },
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
  const BUNKER_APERTURE_HIT_INSET = -3;
  const BUNKER_APERTURE_FX_PADDING = -3;
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

  function getKeypadPressAmount(state, keyIndex, time) {
    if (!state || !state.isOpening || !state.keypadSequence.length) return 0;
    const elapsed = time - state.openingStartedAt;
    let key = null;
    for (const entry of state.keypadSequence) {
      if (entry.keyIndex === keyIndex) {
        key = entry;
        break;
      }
    }
    if (!key) return 0;
    const progress = (elapsed - key.start) / key.duration;
    if (progress <= 0 || progress >= 1) return 0;
    return Math.sin(Math.PI * progress);
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

  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    centerX: window.innerWidth / 2,
    centerY: window.innerHeight / 2,
    scale: Math.min(window.innerWidth, window.innerHeight) * .30,
    labelUnit: 1,
    labelSize: 11,
    urlSize: 8,
    stars: []
  };

  const backgroundCache = {
    canvas: null
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
    viewport.labelUnit = clamp(Math.min(viewport.width, viewport.height) / 600, .62, 1.18);
    viewport.labelSize = clamp(11 * viewport.labelUnit, 8, 13);
    viewport.urlSize = clamp(8 * viewport.labelUnit, 7, 10);
    canvas.width = Math.round(viewport.width * viewport.dpr);
    canvas.height = Math.round(viewport.height * viewport.dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    rebuildStars();
    rebuildBackgroundCache();
    if (app.minis.length) {
      updateGridTargets();
      resizeBunkerWall();
    }
  }

  function screenToWorld(x, y, z = 0) {
    const depth = Math.max(.8, CAMERA_Z - z);
    const perspective = CAMERA_FOCAL / depth;
    const unit = viewport.scale * perspective;
    return vec((x - viewport.centerX) / unit, -(y - viewport.centerY) / unit, z);
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

  function drawBunkerAperturePath(target, aperture, padding = 0) {
    const width = aperture.width + padding * 2;
    const height = aperture.height + padding * 2;
    const cut = clamp(aperture.cut + padding * .18, 8, Math.min(width, height) * .24);
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const left = aperture.x - halfWidth;
    const right = aperture.x + halfWidth;
    const top = aperture.y - halfHeight;
    const bottom = aperture.y + halfHeight;
    target.beginPath();
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

    const speckCount = Math.round(clamp(width * height / 14000, 80, 420));
    for (let i = 0; i < speckCount; i += 1) {
      const normalizedX = (hashNoise(i * 2.71 + 4) + 1) / 2;
      const normalizedY = (hashNoise(i * 4.83 + 19) + 1) / 2;
      const tone = (hashNoise(i * 8.19 + 33) + 1) / 2;
      target.fillStyle = tone > .55 ? 'rgba(215, 217, 204, .055)' : 'rgba(0, 0, 0, .09)';
      target.fillRect(normalizedX * width, normalizedY * height, tone > .7 ? 2 : 1, tone > .7 ? 2 : 1);
    }

    target.save();
    target.lineWidth = 1;
    target.strokeStyle = 'rgba(4, 8, 11, .48)';
    for (let column = 1; column < 8; column += 1) {
      const x = width * column / 8;
      target.beginPath();
      target.moveTo(x, 0);
      target.lineTo(x, height);
      target.stroke();
    }
    for (let row = 1; row < 8; row += 1) {
      const y = height * row / 8;
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
      const platePaddingX = Math.min(34, width * .035);
      const platePaddingY = Math.min(30, height * .035);
      const plateLeft = aperture.x - aperture.width / 2 - platePaddingX;
      const plateTop = aperture.y - aperture.height / 2 - platePaddingY;
      const plateWidth = aperture.width + platePaddingX * 2;
      const plateHeight = aperture.height + platePaddingY * 2;
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
    for (let i = 0; i < 7; i += 1) {
      const x = edgeInset + (width - edgeInset * 2) * i / 6;
      drawHexBolt(target, x, edgeInset, boltRadius, .56);
      drawHexBolt(target, x, height - edgeInset, boltRadius, .56);
    }

    drawBunkerWallText(target, 'SECTOR 04-B', width * .045, height * .055);
    drawBunkerWallText(target, 'ARMOR PLATE // T-09', width * .955, height * .055, 'right', .36);
    drawBunkerWallText(target, 'CAUTION: HIGH VOLTAGE', width * .045, height * .955, 'left', .4);
    drawBunkerWallText(target, 'REINFORCED CONCRETE // 4200 PSI', width * .955, height * .955, 'right', .34);
    drawBunkerBarcode(target, width * .045, height * .12, clamp(width * .085, 54, 105), 24, 17);
    drawBunkerBarcode(target, width * .955 - clamp(width * .085, 54, 105), height * .84, clamp(width * .085, 54, 105), 24, 47);

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

  function drawShutterPanel(target, aperture, seam, bayIndex, topPanel, offsetY) {
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

  function drawShutterKeypad(target, aperture, state, offsetY, time, layout) {
    const {
      keypadWidth,
      keypadHeight,
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
    const enteredCount = getKeypadEnteredCount(state, time);
    const elapsed = state?.isOpening ? time - state.openingStartedAt : -1;
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

    // The device is inset from the right/bottom edges and starts below the
    // lowest point of the concave seam, so it never crosses the seal.
    target.fillStyle = 'rgba(6, 12, 15, .9)';
    target.strokeStyle = 'rgba(123, 161, 160, .5)';
    target.lineWidth = 1;
    target.fillRect(keypadLeft, keypadTop, keypadWidth, keypadHeight);
    target.strokeRect(keypadLeft, keypadTop, keypadWidth, keypadHeight);

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
      for (let column = 0; column < 4; column += 1) {
        const keyIndex = row * 4 + column;
        const pressAmount = getKeypadPressAmount(state, keyIndex, time);
        const x = keypadLeft + padding + column * (keyWidth + gap);
        const y = keypadTop + padding + row * (keyHeight + gap) + pressAmount * 1.5;
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

  function drawApertureShutters(target, aperture, bayIndex, openingProgress = 0, feedback = NO_BULKHEAD_FEEDBACK, time = 0) {
    const mini = app.minis[bayIndex];
    const seam = mini.shutterSeam;
    const travel = (aperture.height + 26) * easeInOutCubic(openingProgress);
    const topOffset = -travel;
    const bottomOffset = travel;

    drawShutterPanel(target, aperture, seam, bayIndex, true, topOffset);
    drawShutterPanel(target, aperture, seam, bayIndex, false, bottomOffset);
    drawShutterKeypad(target, aperture, bulkheadState.bays[bayIndex], bottomOffset, time, mini.keypadLayout);
    drawShutterSlit(target, aperture, topOffset, feedback);
    drawShutterSeam(target, aperture, seam, topOffset);
    drawShutterSeam(target, aperture, seam, bottomOffset);
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

  function drawBunkerWall(time = performance.now()) {
    if (!bunkerWallCacheReady) return;
    const width = viewport.width;
    const height = viewport.height;
    const target = bunkerWallCtx;
    target.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    target.clearRect(0, 0, width, height);
    target.globalCompositeOperation = 'source-over';
    target.drawImage(bunkerWallCacheCanvas, 0, 0, width, height);

    for (const mini of app.minis) {
      const bayState = bulkheadState.bays[mini.index];
      const aperture = mini.aperture;
      const active = app.wallHoveredIndex === mini.index && !bayState.isOpened && !bayState.isOpening;
      target.save();
      drawBunkerAperturePath(target, aperture, 18);
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
        drawApertureShutters(
          target,
          aperture,
          mini.index,
          getBulkheadOpeningProgress(mini.index, time),
          getBulkheadFeedback(mini.index, time),
          time
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
  }

  function hasPersistentApertureFx(state) {
    return state.isOpened || (state.isOpening && state.accessResult === 'granted');
  }

  function drawBunkerLedFx(time = performance.now()) {
    const target = bunkerFxCtx;
    const hasFx = bulkheadState.bays.some((bayState, index) => {
      const persistent = hasPersistentApertureFx(bayState);
      const pulseActive = !persistent && !bayState.isOpening &&
        index === app.wallHoveredIndex && time < bayState.wallPulseUntil;
      return persistent || pulseActive;
    });
    if (!hasFx) {
      if (bunkerFxVisible) {
        target.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
        target.clearRect(0, 0, viewport.width, viewport.height);
        bunkerFxVisible = false;
      }
      return;
    }

    target.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    target.clearRect(0, 0, viewport.width, viewport.height);
    bunkerFxVisible = true;

    for (const mini of app.minis) {
      const bayState = bulkheadState.bays[mini.index];
      const persistent = hasPersistentApertureFx(bayState);
      const pulseActive = !persistent && !bayState.isOpening &&
        mini.index === app.wallHoveredIndex && time < bayState.wallPulseUntil;
      if (!persistent && !pulseActive) continue;
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
    bunkerWallCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bunkerWallCacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bunkerWallCacheReady = true;
    bunkerWallCacheCtx.clearRect(0, 0, width, height);
    drawBunkerWallSurface(bunkerWallCacheCtx);
    drawBunkerWall();
    resizeBunkerFx();
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
    if (!backgroundCache.canvas) backgroundCache.canvas = document.createElement('canvas');
    backgroundCache.canvas.width = width;
    backgroundCache.canvas.height = height;
    const context = backgroundCache.canvas.getContext('2d', { alpha: false });
    context.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    drawStaticBackground(context);
  }

  function drawBackground(time) {
    const w = viewport.width;
    const h = viewport.height;

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
    return {
      points,
      segments,
      projected: points.map(() => ({ x: 0, y: 0 }))
    };
  }

  for (const face of faceDefs) face.textureGeometry = buildFaceTextureGeometry(face);

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

  function projectFaceTexturePoint(cube, localPoint, options, rotation, projected) {
    let x = localPoint.x * cube.half;
    let y = localPoint.y * cube.half;
    let z = localPoint.z * cube.half;

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

    const worldX = cube.position.x + x;
    const worldY = cube.position.y + y;
    const worldZ = cube.position.z + z;
    const depth = Math.max(.8, CAMERA_Z - worldZ);
    const perspective = CAMERA_FOCAL / depth;
    projected.x = viewport.centerX + worldX * viewport.scale * perspective + (options.offsetX || 0);
    projected.y = viewport.centerY - worldY * viewport.scale * perspective + (options.offsetY || 0);
  }

  function strokeProjectedPath(points, color, width, alpha = 1, glow = 0, closed = false) {
    if (!points.length) return;
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
  }

  function drawFaceTexture(cube, face, options, facing, rotation) {
    const visibility = clamp(.38 + facing * .62, .12, 1);
    const alpha = clamp((options.textureAlpha ?? 1) * visibility, 0, 1);
    const textureColor = options.textureColor || VECTOR_COLOR;
    const geometry = face.textureGeometry;
    const projected = geometry.projected;
    for (let i = 0; i < geometry.points.length; i += 1) {
      projectFaceTexturePoint(cube, geometry.points[i], options, rotation, projected[i]);
    }

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = textureColor;
    ctx.lineWidth = Math.max(.72, cube.half * 2.15);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = textureColor;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    for (const [from, to] of geometry.segments) {
      ctx.moveTo(projected[from].x, projected[from].y);
      ctx.lineTo(projected[to].x, projected[to].y);
    }
    ctx.stroke();
  }

  function drawCubeEdges(cube, settings, projectedVertices) {
    ctx.save();
    ctx.globalAlpha = clamp(settings.edgeAlpha, 0, 1);
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
  }

  function renderCube(cube, options = {}, rotationCache = null) {
    const settings = {
      seed: 0,
      vertexJitter: 0,
      offsetX: 0,
      offsetY: 0,
      wireOnly: false,
      textureAlpha: 1,
      textureColor: VECTOR_COLOR,
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

    const rotation = rotationCache || createRotationCache(cube.rotation);
    const geometry = settings.wireOnly
      ? wireRenderGeometry
      : cube.renderGeometry || (cube.renderGeometry = createCubeRenderGeometry());
    const worldVertices = transformedVertices(cube, settings, rotation, geometry.worldVertices);
    const projectedVertices = projectVertices(worldVertices, settings, geometry.projectedVertices);

    if (settings.wireOnly) {
      drawCubeEdges(cube, settings, projectedVertices);
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

    ctx.save();
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
    ctx.restore();

    drawCubeEdges(cube, settings, projectedVertices);

    updateBounds(projectedVertices, geometry.bounds);
    return geometry.hit;
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
      label: navItems[index].label,
      href: navItems[index].href,
      position: vec(),
      aperture: null,
      apertureHitPoints: null,
      apertureFxGeometry: null,
      shutterSeam: null,
      keypadLayout: null,
      shutterGradients: { top: null, bottom: null },
      renderGeometry: createCubeRenderGeometry(),
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
    const cellWidth = viewport.width / 4;
    const rowGap = Math.abs(gridScreenAnchor(0, 1).y - gridScreenAnchor(0, 0).y);
    const apertureWidth = clamp(cellWidth * .72, 44, 220);
    const apertureHeight = clamp(Math.min(viewport.height * .30, rowGap * .78), 104, 250);
    const apertureCut = clamp(Math.min(apertureWidth * .2, apertureHeight * .2), 10, 34);
    for (const mini of app.minis) {
      const anchor = gridScreenAnchor(mini.column, mini.row);
      mini.position = screenToWorld(anchor.x, anchor.y, mini.depth);
      mini.aperture = {
        x: anchor.x,
        y: anchor.y,
        width: apertureWidth,
        height: apertureHeight,
        cut: apertureCut
      };
      mini.apertureHitPoints = getBunkerAperturePoints(mini.aperture, BUNKER_APERTURE_HIT_INSET);
      mini.apertureFxGeometry = createApertureFxGeometry(mini.aperture);
      mini.shutterSeam = getShutterSeamPoints(mini.aperture);
      mini.keypadLayout = getShutterKeypadLayout(mini.aperture);
      mini.shutterGradients = { top: null, bottom: null };
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
    drawBunkerLedFx();
  }

  function drawCubeLabel(mini) {
    if (!mini.hit) return;
    const centerX = (mini.hit.bounds.left + mini.hit.bounds.right) / 2;
    const bottom = mini.hit.bounds.bottom;
    const labelY = bottom + 23 * viewport.labelUnit;
    const urlY = labelY + 13 * viewport.labelUnit;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${viewport.labelSize}px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(227, 255, 246, .78)';
    ctx.shadowColor = 'rgba(0, 255, 102, .28)';
    ctx.shadowBlur = 5;
    ctx.fillText(mini.label, centerX, labelY);
    ctx.shadowBlur = 0;
    ctx.font = `${viewport.urlSize}px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(0, 255, 102, .53)';
    ctx.fillText(mini.href, centerX, urlY);
  }

  function renderMini(mini, time, frameSeed) {
    const bayState = bulkheadState.bays[mini.index];
    const hovered = bayState.isOpened && !bayState.isOpening && mini.hovered;
    const feedback = getBulkheadFeedback(mini.index, time);
    const unlockHighlight = feedback.intensity > .02;
    const glitchActive = glitch.active;
    const rotation = createRotationCache(mini.rotation);
    if (glitchActive) {
      renderCube(mini, {
        wireOnly: true,
        edgeColor: GLITCH_MAGENTA,
        edgeAlpha: .84 * glitch.intensity,
        offsetX: -4.5 * glitch.intensity,
        offsetY: .8 * glitch.intensity,
        vertexJitter: .075 * glitch.intensity,
        seed: frameSeed + mini.index * 9
      }, rotation);
      renderCube(mini, {
        wireOnly: true,
        edgeColor: GLITCH_CYAN,
        edgeAlpha: .88 * glitch.intensity,
        offsetX: 4.5 * glitch.intensity,
        offsetY: -.8 * glitch.intensity,
        vertexJitter: .07 * glitch.intensity,
        seed: frameSeed + mini.index * 11 + 29
      }, rotation);
    }
    mini.hit = renderCube(mini, {
      vertexJitter: glitchActive ? .06 * glitch.intensity : 0,
      seed: frameSeed + mini.index,
      edgeAlpha: unlockHighlight ? 1.18 + feedback.intensity * .22 : hovered ? 1.35 : .92,
      edgeColor: unlockHighlight ? feedback.color : hovered ? '#ffffff' : EDGE_COLOR,
      faceOutlineColor: unlockHighlight ? feedback.color : VECTOR_COLOR,
      textureColor: unlockHighlight ? feedback.color : VECTOR_COLOR,
      fillAlpha: unlockHighlight ? 1.02 + feedback.intensity * .14 : hovered ? 1.16 : .88,
      textureAlpha: unlockHighlight ? 1.02 + feedback.intensity * .16 : hovered ? 1.18 : .82
    }, rotation);
  }

  function render(time) {
    drawBackground(time);
    updateGlitch(time);

    const frameSeed = glitch.active ? glitch.seed + Math.floor(time / 16.6667) : 0;
    for (const mini of app.minis) renderMini(mini, time, frameSeed);
    ctx.save();
    for (const mini of app.minis) drawCubeLabel(mini);
    ctx.restore();

    updateHover();
  }

  function frame(time) {
    const elapsed = Math.min(42, time - app.lastTime);
    const dt = elapsed / 1000;
    app.lastTime = time;

    updateBulkheadOpening(time);
    if (bunkerFxVisible || bulkheadState.bays.some(hasPersistentApertureFx)) {
      drawBunkerLedFx(time);
    }
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
    if (!staticGlitchAudio.unlocked) unlockStaticGlitchAudio();
    if (!keypadAudio.context || keypadAudio.context.state !== 'running') unlockKeypadAudio();
  }

  window.addEventListener('pointerdown', unlockAllAudio, { capture: true });
  window.addEventListener('touchstart', unlockAllAudio, { capture: true, passive: true });
  window.addEventListener('keydown', unlockAllAudio, { capture: true });

  canvas.addEventListener('pointermove', (event) => {
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
    app.pointerActive = true;
    app.pointer = pointerPosition(event);
    const wallHit = hitTestWall(app.pointer);
    if (wallHit >= 0) {
      beginBulkheadOpening(wallHit, performance.now());
      return;
    }
    const hit = hitTestCube(app.pointer);
    if (hit >= 0) {
      const destination = app.minis[hit].href;
      window.location.assign(destination);
    }
  });

  canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') canvas.blur();
  });

  window.addEventListener('resize', resizeCanvas, { passive: true });

  preloadStaticGlitchAudio();
  buildMinis();
  resizeCanvas();
  requestAnimationFrame(frame);
})();
