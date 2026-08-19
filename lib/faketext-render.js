// Draws iMessage-style chat screenshots for the Fake-Text Video Generator.
// Uses node-canvas directly (no headless browser) to keep this cheap on
// memory — important on a free-tier server that already runs ffmpeg.
const { createCanvas } = require("@napi-rs/canvas");

const WIDTH = 1080;
const HEIGHT = 1920;
const BUBBLE_MAX_WIDTH = 760;
const PADDING_X = 60;

function wrapText(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// messages: [{ sender: "me" | "them", text: "..." }]
// visibleCount: how many messages to draw (for the progressive reveal effect)
// contactName: shown in the header bar
function renderFrame(messages, visibleCount, contactName) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Header bar
  ctx.fillStyle = "#111113";
  ctx.fillRect(0, 0, WIDTH, 180);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 40px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(contactName || "Unknown", WIDTH / 2, 110);
  ctx.strokeStyle = "#2a2a2e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 180);
  ctx.lineTo(WIDTH, 180);
  ctx.stroke();

  // Bubbles — render bottom-up so the latest messages anchor to the bottom
  // of the screen (like a real chat that's scrolled to the newest message).
  const visible = messages.slice(0, visibleCount);
  ctx.font = "36px sans-serif";
  const bubbleData = visible.map((m) => {
    const lines = wrapText(ctx, m.text, BUBBLE_MAX_WIDTH - 60);
    const bubbleHeight = lines.length * 46 + 44;
    return { ...m, lines, bubbleHeight };
  });

  let y = HEIGHT - 60;
  const positioned = [];
  for (let i = bubbleData.length - 1; i >= 0; i--) {
    const b = bubbleData[i];
    y -= b.bubbleHeight;
    positioned.unshift({ ...b, y });
    y -= 28; // gap between bubbles
    if (y < 220) break; // stop once we run off the top of the visible area
  }

  for (const b of positioned) {
    const isMe = b.sender === "me";
    ctx.font = "36px sans-serif";
    const textWidths = b.lines.map((l) => ctx.measureText(l).width);
    const bubbleWidth = Math.min(BUBBLE_MAX_WIDTH, Math.max(...textWidths) + 60);
    const x = isMe ? WIDTH - PADDING_X - bubbleWidth : PADDING_X;

    ctx.fillStyle = isMe ? "#0b84fe" : "#26262a";
    roundRect(ctx, x, b.y, bubbleWidth, b.bubbleHeight, 32);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    b.lines.forEach((line, li) => {
      ctx.fillText(line, x + 30, b.y + 46 + li * 46);
    });
  }

  return canvas.toBuffer("image/png");
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

module.exports = { renderFrame };
