import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_FILE = path.join(__dirname, 'data', 'app.json');
const WALLS_DIR = path.join(__dirname, 'uploads', 'walls');
const PIECES_DIR = path.join(__dirname, 'uploads', 'pieces');

// Ensure directories exist on startup
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.mkdirSync(WALLS_DIR, { recursive: true });
fs.mkdirSync(PIECES_DIR, { recursive: true });

// ── data helpers ────────────────────────────────────────────────────────────
function readData() {
  if (!fs.existsSync(DATA_FILE)) return { walls: {}, layouts: {} };
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { walls: {}, layouts: {} };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function dataUrlToBuffer(dataUrl) {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid dataUrl');
  const mimeType = matches[1];
  const buffer = Buffer.from(matches[2], 'base64');
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  return { buffer, ext };
}

// ── app setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── GET /api/state ────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  res.json(readData());
});

// ── PUT /api/walls/:id ────────────────────────────────────────────────────────
app.put('/api/walls/:id', (req, res) => {
  const data = readData();
  const wall = req.body;
  if (!data.walls) data.walls = {};
  data.walls[req.params.id] = wall;
  writeData(data);
  res.json({ ok: true });
});

// ── DELETE /api/walls/:id ─────────────────────────────────────────────────────
app.delete('/api/walls/:id', (req, res) => {
  const { id } = req.params;
  const data = readData();

  // Remove wall metadata
  if (data.walls) delete data.walls[id];

  // Remove layouts for this wall
  if (data.layouts) delete data.layouts[id];

  // Remove wall image file (any extension)
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const imgPath = path.join(WALLS_DIR, `${id}.${ext}`);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }

  writeData(data);
  res.json({ ok: true });
});

// ── POST /api/walls/:id/image ─────────────────────────────────────────────────
app.post('/api/walls/:id/image', (req, res) => {
  const { id } = req.params;
  const { dataUrl } = req.body;

  try {
    const { buffer, ext } = dataUrlToBuffer(dataUrl);
    const filename = `${id}.${ext}`;
    const filePath = path.join(WALLS_DIR, filename);

    // Remove any old wall image for this id (different ext)
    for (const e of ['jpg', 'jpeg', 'png', 'webp']) {
      const old = path.join(WALLS_DIR, `${id}.${e}`);
      if (e !== ext && fs.existsSync(old)) fs.unlinkSync(old);
    }

    fs.writeFileSync(filePath, buffer);
    res.json({ url: `/uploads/walls/${filename}` });
  } catch (err) {
    console.error('wall image upload error', err);
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/piece-images/:id ────────────────────────────────────────────────
app.post('/api/piece-images/:id', (req, res) => {
  const { id } = req.params;
  const { dataUrl } = req.body;

  try {
    const { buffer, ext } = dataUrlToBuffer(dataUrl);
    const filename = `${id}.${ext}`;
    const filePath = path.join(PIECES_DIR, filename);

    // Remove any old piece image for this id (different ext)
    for (const e of ['jpg', 'jpeg', 'png', 'webp']) {
      const old = path.join(PIECES_DIR, `${id}.${e}`);
      if (e !== ext && fs.existsSync(old)) fs.unlinkSync(old);
    }

    fs.writeFileSync(filePath, buffer);
    res.json({ url: `/uploads/pieces/${filename}` });
  } catch (err) {
    console.error('piece image upload error', err);
    res.status(400).json({ error: err.message });
  }
});

// ── DELETE /api/piece-images/:id ──────────────────────────────────────────────
app.delete('/api/piece-images/:id', (req, res) => {
  const { id } = req.params;
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const filePath = path.join(PIECES_DIR, `${id}.${ext}`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  res.json({ ok: true });
});

// ── PUT /api/layouts/:wallId/:name ────────────────────────────────────────────
app.put('/api/layouts/:wallId/:name', (req, res) => {
  const { wallId, name } = req.params;
  const { pieces } = req.body;
  const data = readData();
  if (!data.layouts) data.layouts = {};
  if (!data.layouts[wallId]) data.layouts[wallId] = {};
  data.layouts[wallId][name] = pieces;
  writeData(data);
  res.json({ ok: true });
});

// ── DELETE /api/layouts/:wallId/:name ─────────────────────────────────────────
app.delete('/api/layouts/:wallId/:name', (req, res) => {
  const { wallId, name } = req.params;
  const data = readData();
  if (data.layouts?.[wallId]) {
    delete data.layouts[wallId][name];
    if (Object.keys(data.layouts[wallId]).length === 0) {
      delete data.layouts[wallId];
    }
    writeData(data);
  }
  res.json({ ok: true });
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Gallery Wall backend running on http://localhost:${PORT}`);
});
