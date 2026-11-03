// 3D model preview (STL / OBJ / 3MF) in a dialog, using three.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';

const dlg = document.getElementById('preview-dlg');
const canvas = dlg.querySelector('.pv-canvas');
const msg = dlg.querySelector('.pv-msg');
let renderer, frame;

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

async function load(item, color = css('--accent')) {
  const url = `/api/library/${encodeURIComponent(item.id)}/download`;
  const ext = item.name.split('.').pop().toLowerCase();
  const buf = await (await fetch(url)).arrayBuffer();
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
  if (ext === 'stl') {
    // Many exported STLs carry zeroed facet normals; recompute them.
    const geom = new STLLoader().parse(buf);
    geom.deleteAttribute('normal');
    geom.computeVertexNormals();
    return new THREE.Mesh(geom, material);
  }
  if (ext === 'obj') {
    const obj = new OBJLoader().parse(new TextDecoder().decode(buf));
    obj.traverse((c) => { if (c.isMesh) c.material = material; });
    return obj;
  }
  if (ext === '3mf') return new ThreeMFLoader().parse(buf);
  throw new Error(`No preview for .${ext} files`);
}

async function open(item) {
  dlg.querySelector('.pv-title').textContent = item.name;
  dlg.querySelector('.pv-dims').textContent = '';
  msg.textContent = 'Loading…';
  msg.hidden = false;
  dlg.showModal();

  renderer ||= new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const w = canvas.clientWidth || 640, h = canvas.clientHeight || 420;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setSize(w, h, false);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 10000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  let obj;
  try {
    obj = await load(item);
  } catch (err) {
    msg.textContent = err.message;
    return;
  }
  // Slicers use Z-up; three.js is Y-up.
  obj.rotation.x = -Math.PI / 2;
  scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  const radius = Math.max(size.x, size.y, size.z) || 1;
  const grid = new THREE.GridHelper(Math.ceil(radius * 1.6 / 10) * 10, 10, css('--border'), css('--border'));
  scene.add(grid);
  camera.position.set(radius * 1.6, radius * 1.3, radius * 2.0);
  controls.target.set(0, size.y / 2, 0);
  controls.update();
  msg.hidden = true;
  // Model units are mm; three's Y is the model's Z (height).
  dlg.querySelector('.pv-dims').textContent = `${size.x.toFixed(1)} × ${size.z.toFixed(1)} × ${size.y.toFixed(1)} mm (W × D × H)`;

  cancelAnimationFrame(frame);
  const tick = () => { controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(tick); };
  tick();
  dlg.addEventListener('close', () => {
    cancelAnimationFrame(frame);
    controls.dispose();
    scene.traverse((c) => { c.geometry?.dispose?.(); });
  }, { once: true });
}

// A small picture of a model for the library, as a PNG blob.
async function thumbnail(item) {
  const size = 300;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  try {
    r.setSize(size, size, false);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 2, 1.5);
    scene.add(sun);
    // A plain grey, as this picture is kept and shown under every theme.
    const obj = await load(item, '#b4b8bf');
    obj.rotation.x = -Math.PI / 2;
    scene.add(obj);
    const sphere = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere());
    if (!(sphere.radius > 0)) throw new Error('Empty model');
    const camera = new THREE.PerspectiveCamera(30, 1, sphere.radius / 100, sphere.radius * 100);
    const view = new THREE.Vector3(0.55, 0.6, 1).normalize();
    camera.position.copy(sphere.center).addScaledVector(view, (sphere.radius * 1.05) / Math.sin((30 * Math.PI) / 360));
    camera.lookAt(sphere.center);
    r.render(scene, camera);
    const blob = await new Promise((resolve) => { r.domElement.toBlob(resolve, 'image/png'); });
    scene.traverse((c) => { c.geometry?.dispose?.(); });
    if (!blob) throw new Error('Could not draw the model');
    return blob;
  } finally {
    r.dispose();
    r.forceContextLoss();
  }
}

window.Preview = { open, thumbnail, supports: (name) => /\.(stl|obj|3mf)$/i.test(name) };
