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

  const bunkerWall = {
    cacheWidth: 0,
    cacheHeight: 0,
    cacheDpr: 0
  };

  const bulkheadState = {
    bays: Array.from({ length: navItems.length }, () => ({
      isOpened: false,
      isOpening: false,
      openingStartedAt: 0,
      keypadSequence: [],
      ledPersistent: false,
      wallPulseUntil: 0
    }))
  };

  const BULKHEAD_TIMING = {
    keypadDuration: 500,
    unlockDuration: 400,
    slideDuration: 800
  };
  const BUNKER_APERTURE_HIT_INSET = -3;
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
    const key = state.keypadSequence.find((entry) => entry.keyIndex === keyIndex);
    if (!key) return 0;
    const progress = (elapsed - key.start) / key.duration;
    if (progress <= 0 || progress >= 1) return 0;
    return Math.sin(Math.PI * progress);
  }

  function getKeypadEnteredCount(state, time) {
    if (!state || !state.isOpening || !state.keypadSequence.length) return 0;
    const elapsed = time - state.openingStartedAt;
    return state.keypadSequence.filter((entry) => elapsed >= entry.start).length;
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
    if (app.minis.length) {
      updateGridTargets();
      resizeBunkerWall();
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

  function getBunkerAperture(mini) {
    const anchor = gridScreenAnchor(mini.column, mini.row);
    const cellWidth = viewport.width / 4;
    const rowGap = Math.abs(gridScreenAnchor(0, 1).y - gridScreenAnchor(0, 0).y);
    const width = clamp(cellWidth * .72, 44, 220);
    const height = clamp(Math.min(viewport.height * .30, rowGap * .78), 104, 250);
    const cut = clamp(Math.min(width * .2, height * .2), 10, 34);
    return { x: anchor.x, y: anchor.y, width, height, cut };
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

  function drawBunkerAperturePath(target, aperture, padding = 0) {
    const points = getBunkerAperturePoints(aperture, padding);
    target.beginPath();
    target.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) target.lineTo(points[i].x, points[i].y);
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
      const aperture = getBunkerAperture(mini);
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
    target.moveTo(width * .975, height * .18);
    target.lineTo(width * .975, height * .82);
    target.lineTo(width * .92, height * .86);
    target.stroke();
    target.strokeStyle = 'rgba(102, 145, 148, .38)';
    target.lineWidth = 2;
    target.stroke();
    target.strokeStyle = 'rgba(0, 240, 255, .22)';
    target.lineWidth = 1;
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
    target.fillStyle = 'rgba(0, 240, 255, .56)';
    target.shadowColor = 'rgba(0, 240, 255, .55)';
    target.shadowBlur = 6;
    for (let i = 0; i < 12; i += 1) {
      const y = height * (.17 + i * .056);
      target.fillRect(width * .035, y, 5 + (i % 3) * 3, 2);
      target.fillRect(width * .965 - 8 - (i % 3) * 3, y, 5 + (i % 3) * 3, 2);
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
    const gradient = topPanel
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

  function drawShutterKeypad(target, aperture, state, offsetY, time) {
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
    const enteredCount = getKeypadEnteredCount(state, time);
    const gap = clamp(Math.min(keypadWidth, keypadHeight) * .07, 1.5, 3);
    const padding = 2;
    const keyWidth = (keypadWidth - padding * 2 - gap * 3) / 4;
    const keyHeight = (keypadHeight - padding * 2 - gap * 4) / 5;

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

    target.fillStyle = 'rgba(3, 10, 13, .96)';
    target.strokeStyle = 'rgba(118, 177, 180, .72)';
    target.fillRect(displayLeft, displayTop, displayWidth, displayHeight);
    target.strokeRect(displayLeft, displayTop, displayWidth, displayHeight);
    target.strokeStyle = 'rgba(0, 240, 255, .48)';
    target.beginPath();
    target.moveTo(displayLeft + 1, displayTop + 1);
    target.lineTo(displayLeft + displayWidth - 1, displayTop + 1);
    target.moveTo(displayLeft + 1, displayTop + displayHeight - 1);
    target.lineTo(displayLeft + displayWidth - 1, displayTop + displayHeight - 1);
    target.stroke();
    if (enteredCount > 0) {
      target.font = `${clamp(displayHeight * 1.15, 5, 8)}px ${FONT_STACK}`;
      target.textAlign = 'center';
      target.textBaseline = 'middle';
      target.fillStyle = '#00ff00';
      target.shadowColor = 'rgba(0, 255, 0, .92)';
      target.shadowBlur = 5;
      target.fillText('*'.repeat(enteredCount), deviceCenterX, displayTop + displayHeight * .54);
      target.shadowBlur = 0;
    }
    const scanX = displayLeft + ((time * .0011) % 1) * displayWidth;
    target.strokeStyle = 'rgba(0, 240, 255, .62)';
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

  function drawShutterSlit(target, aperture, offsetY, unlockGlow) {
    target.save();
    drawBunkerAperturePath(target, aperture);
    target.clip();
    target.translate(0, offsetY);
    target.globalCompositeOperation = 'destination-out';
    drawShutterSlitPath(target, aperture);
    target.fill();
    target.globalCompositeOperation = 'source-over';
    if (unlockGlow > 0) {
      target.fillStyle = `rgba(0, 255, 0, ${.14 + unlockGlow * .28})`;
      target.shadowColor = 'rgba(0, 255, 0, .92)';
      target.shadowBlur = 12 + unlockGlow * 14;
      drawShutterSlitPath(target, aperture);
      target.fill();
      target.shadowBlur = 0;
    }
    drawShutterSlitPath(target, aperture);
    target.strokeStyle = 'rgba(4, 9, 12, .96)';
    target.lineWidth = 4;
    target.stroke();
    target.strokeStyle = unlockGlow > 0
      ? 'rgba(0, 255, 0, .96)'
      : 'rgba(0, 240, 255, .42)';
    target.lineWidth = unlockGlow > 0 ? 1.5 : 1;
    target.shadowColor = unlockGlow > 0 ? 'rgba(0, 255, 0, .95)' : 'rgba(0, 240, 255, .42)';
    target.shadowBlur = unlockGlow > 0 ? 12 : 6;
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

  function drawApertureShutters(target, aperture, bayIndex, openingProgress = 0, unlockGlow = 0, time = 0) {
    const seam = getShutterSeamPoints(aperture);
    const travel = (aperture.height + 26) * easeInOutCubic(openingProgress);
    const topOffset = -travel;
    const bottomOffset = travel;

    drawShutterPanel(target, aperture, seam, bayIndex, true, topOffset);
    drawShutterPanel(target, aperture, seam, bayIndex, false, bottomOffset);
    drawShutterKeypad(target, aperture, bulkheadState.bays[bayIndex], bottomOffset, time);
    drawShutterSlit(target, aperture, topOffset, unlockGlow);
    drawShutterSeam(target, aperture, seam, topOffset);
    drawShutterSeam(target, aperture, seam, bottomOffset);
  }

  function getBulkheadOpeningProgress(bayIndex, time) {
    const state = bulkheadState.bays[bayIndex];
    if (!state) return 0;
    if (!state.isOpening) return state.isOpened ? 1 : 0;
    const elapsed = time - state.openingStartedAt;
    const slideElapsed = Math.max(
      0,
      elapsed - BULKHEAD_TIMING.keypadDuration - BULKHEAD_TIMING.unlockDuration
    );
    return clamp(slideElapsed / BULKHEAD_TIMING.slideDuration, 0, 1);
  }

  function getBulkheadUnlockGlow(bayIndex, time) {
    const state = bulkheadState.bays[bayIndex];
    if (!state || !state.isOpening) return 0;
    const elapsed = time - state.openingStartedAt - BULKHEAD_TIMING.keypadDuration;
    if (elapsed < 0 || elapsed >= BULKHEAD_TIMING.unlockDuration) return 0;
    return Math.pow(Math.abs(Math.sin(elapsed / BULKHEAD_TIMING.unlockDuration * Math.PI * 3)), 8);
  }

  function drawBunkerWall(time = performance.now()) {
    if (!bunkerWallCanvas || !bunkerWallCtx || !bunkerWall.cacheWidth) return;
    const width = viewport.width;
    const height = viewport.height;
    const target = bunkerWallCtx;
    target.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    target.clearRect(0, 0, width, height);
    target.globalCompositeOperation = 'source-over';
    target.drawImage(bunkerWallCacheCanvas, 0, 0, width, height);

    for (const mini of app.minis) {
      const bayState = bulkheadState.bays[mini.index];
      const aperture = getBunkerAperture(mini);
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
          getBulkheadUnlockGlow(mini.index, time),
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

  function drawBunkerLedFx(time = performance.now()) {
    if (!bunkerFxCanvas || !bunkerFxCtx) return;
    const target = bunkerFxCtx;
    const hasFx = bulkheadState.bays.some((bayState, index) => {
      const persistent = bayState.isOpened || bayState.isOpening || bayState.ledPersistent;
      const pulseActive = !persistent && index === app.wallHoveredIndex && time < bayState.wallPulseUntil;
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
      const persistent = bayState.isOpened || bayState.isOpening || bayState.ledPersistent;
      const pulseActive = !persistent && mini.index === app.wallHoveredIndex && time < bayState.wallPulseUntil;
      if (!persistent && !pulseActive) continue;
      const aperture = getBunkerAperture(mini);
      const phase = (time * .00072 + mini.index * .17) % 1;
      const breathe = .56 + Math.sin(time * .006 + mini.index * .8) * .22;
      target.save();
      drawBunkerAperturePath(target, aperture, -3);
      target.strokeStyle = `rgba(0, 240, 255, ${.24 + breathe * .18})`;
      target.lineWidth = 2;
      target.shadowColor = 'rgba(0, 240, 255, .72)';
      target.shadowBlur = 10;
      target.stroke();
      target.setLineDash([Math.max(9, aperture.width * .14), Math.max(48, aperture.width * .8)]);
      target.lineDashOffset = -phase * 140;
      target.strokeStyle = `rgba(0, 240, 255, ${.48 + breathe * .28})`;
      target.lineWidth = 1.5;
      target.shadowBlur = 14;
      target.stroke();
      target.setLineDash([]);
      target.lineDashOffset = 0;
      target.strokeStyle = `rgba(198, 44, 255, ${.24 + breathe * .18})`;
      target.lineWidth = 1;
      target.shadowColor = 'rgba(198, 44, 255, .66)';
      target.shadowBlur = 8;
      target.setLineDash([Math.max(6, aperture.width * .09), Math.max(62, aperture.width * .95)]);
      target.lineDashOffset = phase * 180 + 36;
      target.stroke();
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
    bunkerWall.cacheWidth = width;
    bunkerWall.cacheHeight = height;
    bunkerWall.cacheDpr = dpr;
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
    } catch (error) {
      return false;
    }
  }

  function updateKeypadAudio(state, elapsed) {
    if (elapsed > BULKHEAD_TIMING.keypadDuration) {
      for (const key of state.keypadSequence) key.played = true;
      return;
    }
    for (const key of state.keypadSequence) {
      if (key.played || elapsed < key.start) continue;
      key.played = true;
      playKeypadClick(key.keyIndex);
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
    state: 'grid',
    interactionEnabled: true,
    hoveredIndex: -1,
    wallHoveredIndex: -1,
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
    state.keypadSequence = [];
    state.ledPersistent = nextState;
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
    state.keypadSequence = createKeypadSequence();
    state.ledPersistent = true;
    state.wallPulseUntil = 0;
    resetHoverState();
    drawBunkerWall(time);
    drawBunkerLedFx(time);
    return true;
  }

  function updateBulkheadOpening(time) {
    const duration = BULKHEAD_TIMING.keypadDuration +
      BULKHEAD_TIMING.unlockDuration +
      BULKHEAD_TIMING.slideDuration;
    let hasOpening = false;
    for (const state of bulkheadState.bays) {
      if (!state.isOpening) continue;
      hasOpening = true;
      const elapsed = time - state.openingStartedAt;
      updateKeypadAudio(state, elapsed);
      if (time - state.openingStartedAt >= duration) {
        state.isOpening = false;
        state.isOpened = true;
        state.keypadSequence = [];
        state.ledPersistent = true;
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

  function updateMinis(dt, time) {
    for (const mini of app.minis) {
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
    if (!app.interactionEnabled) return -1;
    for (let i = app.minis.length - 1; i >= 0; i -= 1) {
      const bayState = bulkheadState.bays[i];
      if (!bayState.isOpened || bayState.isOpening) continue;
      const aperture = getBunkerAperture(app.minis[i]);
      if (!pointInPolygon(point, getBunkerAperturePoints(aperture, BUNKER_APERTURE_HIT_INSET))) continue;
      if (cubeIsHit(point, app.minis[i].hit, 6)) return i;
    }
    return -1;
  }

  function hitTestWall(point) {
    if (!app.interactionEnabled) return -1;
    for (let i = app.minis.length - 1; i >= 0; i -= 1) {
      const bayState = bulkheadState.bays[i];
      if (bayState.isOpened || bayState.isOpening) continue;
      const aperture = getBunkerAperture(app.minis[i]);
      const innerAperture = getBunkerAperturePoints(aperture, BUNKER_APERTURE_HIT_INSET);
      if (pointInPolygon(point, innerAperture)) return i;
    }
    return -1;
  }

  function updateHover() {
    const nextWall = hitTestWall(app.pointer);
    const nextCube = nextWall >= 0 ? -1 : hitTestCube(app.pointer);
    const previousWall = app.wallHoveredIndex;
    const wallChanged = nextWall !== app.wallHoveredIndex;
    if (nextWall >= 0 && nextWall !== previousWall) {
      bulkheadState.bays[nextWall].wallPulseUntil = performance.now() + 620;
    }
    app.hoveredIndex = nextCube;
    app.wallHoveredIndex = nextWall;
    for (const mini of app.minis) {
      mini.hovered = bulkheadState.bays[mini.index].isOpened && mini.index === nextCube;
    }
    canvas.classList.toggle('is-wall-hovered', nextWall >= 0);
    canvas.classList.toggle('is-cube-hovered', nextCube >= 0);
    if (wallChanged) drawBunkerWall();
    drawBunkerLedFx();
  }

  function drawCubeLabel(mini) {
    if (!mini.hit) return;
    const centerX = (mini.hit.bounds.left + mini.hit.bounds.right) / 2;
    const bottom = mini.hit.bounds.bottom;
    const unit = clamp(Math.min(viewport.width, viewport.height) / 600, .62, 1.18);
    const labelSize = clamp(11 * unit, 8, 13);
    const urlSize = clamp(8 * unit, 7, 10);
    const labelY = bottom + 23 * unit;
    const urlY = labelY + 13 * unit;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${labelSize}px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(227, 255, 246, .78)';
    ctx.shadowColor = 'rgba(0, 255, 102, .28)';
    ctx.shadowBlur = 5;
    ctx.fillText(mini.label, centerX, labelY);
    ctx.shadowBlur = 0;
    ctx.font = `${urlSize}px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(0, 255, 102, .53)';
    ctx.fillText(mini.href, centerX, urlY);
    ctx.restore();
  }

  function renderMini(mini, time) {
    const bayState = bulkheadState.bays[mini.index];
    const hovered = bayState.isOpened && !bayState.isOpening && mini.hovered;
    const unlockGlow = getBulkheadUnlockGlow(mini.index, time);
    const unlockHighlight = unlockGlow > .02;
    const glitchActive = glitch.active;
    const frameSeed = glitch.seed + Math.floor(time / 16.6667);
    if (glitchActive) {
      renderCube(mini, {
        wireOnly: true,
        edgeColor: GLITCH_MAGENTA,
        edgeAlpha: .84 * glitch.intensity,
        offsetX: -4.5 * glitch.intensity,
        offsetY: .8 * glitch.intensity,
        vertexJitter: .075 * glitch.intensity,
        seed: frameSeed + mini.index * 9
      });
      renderCube(mini, {
        wireOnly: true,
        edgeColor: GLITCH_CYAN,
        edgeAlpha: .88 * glitch.intensity,
        offsetX: 4.5 * glitch.intensity,
        offsetY: -.8 * glitch.intensity,
        vertexJitter: .07 * glitch.intensity,
        seed: frameSeed + mini.index * 11 + 29
      });
    }
    mini.hit = renderCube(mini, {
      vertexJitter: glitchActive ? .06 * glitch.intensity : 0,
      seed: frameSeed + mini.index,
      edgeAlpha: unlockHighlight ? 1.18 + unlockGlow * .22 : hovered ? 1.35 : .92,
      edgeColor: unlockHighlight ? '#00ff00' : hovered ? '#ffffff' : EDGE_COLOR,
      fillAlpha: unlockHighlight ? 1.02 + unlockGlow * .14 : hovered ? 1.16 : .88,
      textureAlpha: unlockHighlight ? 1.02 + unlockGlow * .16 : hovered ? 1.18 : .82
    });
  }

  function render(time) {
    drawBackground(time);
    updateGlitch(time);

    for (const mini of app.minis) renderMini(mini, time);
    for (const mini of app.minis) drawCubeLabel(mini);

    updateHover();
  }

  function frame(time) {
    const elapsed = Math.min(42, time - app.lastTime);
    const dt = elapsed / 1000;
    app.lastTime = time;

    updateBulkheadOpening(time);
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
    unlockKeypadAudio();
  }

  window.addEventListener('pointerdown', unlockAllAudio, { capture: true });
  window.addEventListener('touchstart', unlockAllAudio, { capture: true, passive: true });
  window.addEventListener('keydown', unlockAllAudio, { capture: true });

  canvas.addEventListener('pointermove', (event) => {
    app.pointer = pointerPosition(event);
    updateHover();
  });

  canvas.addEventListener('pointerleave', () => {
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
    unlockAllAudio();
    app.pointer = pointerPosition(event);
    const wallHit = hitTestWall(app.pointer);
    if (wallHit >= 0) {
      beginBulkheadOpening(wallHit, performance.now());
      return;
    }
    const hit = hitTestCube(app.pointer);
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
  buildMinis();
  resizeCanvas();
  updateGridTargets();
  requestAnimationFrame(frame);
})();
