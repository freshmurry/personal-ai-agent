// canvas.js
// Subtle ambient background using p5.js
// Safe with streaming chat + heavy DOM usage

let dots = [];
const DOT_COUNT = 42;

function setup() {
  const c = createCanvas(window.innerWidth, window.innerHeight);
  c.parent(document.body);

  c.elt.style.position = 'fixed';
  c.elt.style.top = '0';
  c.elt.style.left = '0';
  c.elt.style.zIndex = '0';
  c.elt.style.pointerEvents = 'none';

  for (let i = 0; i < DOT_COUNT; i++) {
    dots.push(makeDot());
  }

  noStroke();
}

function windowResized() {
  resizeCanvas(window.innerWidth, window.innerHeight);
}

function draw() {
  clear();

  for (const d of dots) {
    moveDot(d);
    renderDot(d);
  }
}

/* ---------------- helpers ---------------- */

function makeDot() {
  return {
    x: random(width),
    y: random(height),
    r: random(18, 40),
    dx: random(-0.12, 0.12),
    dy: random(-0.12, 0.12),
    a: random(18, 38),
  };
}

function moveDot(d) {
  d.x += d.dx;
  d.y += d.dy;

  if (d.x < -60) d.x = width + 60;
  if (d.x > width + 60) d.x = -60;
  if (d.y < -60) d.y = height + 60;
  if (d.y > height + 60) d.y = -60;
}

function renderDot(d) {
  fill(244, 240, 232, d.a); // warm neutral
  ellipse(d.x, d.y, d.r);
}