import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import canvas from 'canvas';
import * as faceapi from '@vladmandic/face-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Configuration
const DATA_DIR = path.join(rootDir, 'public', 'data', 'people');
const MEDIA_DIR = path.join(rootDir, 'Data', 'Media');
const AVATAR_DIR = path.join(rootDir, 'public', 'avatars');
const MODEL_DIR = path.join(rootDir, 'node_modules', '@vladmandic', 'face-api', 'model');

// Avatar settings
const AVATAR_SIZE = 200;
const FACE_PADDING = 0.4; // 40% padding around detected face

// Setup face-api to use node-canvas
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return;

  console.log('Loading face detection models...');
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_DIR);
  console.log('✓ Models loaded (SSD MobileNet + Tiny Face Detector)');
  modelsLoaded = true;
}

async function detectFace(imagePath) {
  try {
    // Load image using canvas
    const img = await canvas.loadImage(imagePath);

    // Try SSD MobileNet first (more accurate)
    let detections = await faceapi.detectAllFaces(img);

    // If no faces found, try Tiny Face Detector (better for small/old photos)
    if (detections.length === 0) {
      detections = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions());
    }

    if (detections.length === 0) {
      return null;
    }

    // Get the first (largest) face detection
    const detection = detections[0];
    const box = detection.box;

    // Add padding around face
    const padding = Math.max(box.width, box.height) * FACE_PADDING;
    const x = Math.max(0, Math.floor(box.x - padding));
    const y = Math.max(0, Math.floor(box.y - padding));
    const width = Math.min(img.width - x, Math.ceil(box.width + padding * 2));
    const height = Math.min(img.height - y, Math.ceil(box.height + padding * 2));

    return { x, y, width, height };
  } catch (error) {
    // Silently fail on detection errors - we'll fall back to smart crop
    return null;
  }
}

async function createAvatar(imagePath, personId, photoIndex) {
  try {
    // Detect face first
    const faceBox = await detectFace(imagePath);

    let avatarImage;

    if (faceBox) {
      // Face detected - crop to face with padding
      avatarImage = sharp(imagePath)
        .extract({
          left: faceBox.x,
          top: faceBox.y,
          width: faceBox.width,
          height: faceBox.height
        });
    } else {
      // No face detected - use attention-based smart crop
      avatarImage = sharp(imagePath);
    }

    // Resize to avatar size (square)
    const avatarBuffer = await avatarImage
      .resize(AVATAR_SIZE, AVATAR_SIZE, {
        fit: 'cover',
        position: faceBox ? 'center' : sharp.strategy.attention
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Save avatar
    const avatarFilename = `${personId}_${photoIndex}.jpg`;
    const avatarPath = path.join(AVATAR_DIR, avatarFilename);
    fs.writeFileSync(avatarPath, avatarBuffer);

    return {
      path: `avatars/${avatarFilename}`,
      hasFace: !!faceBox
    };
  } catch (error) {
    console.log(`  Error creating avatar from ${path.basename(imagePath)}: ${error.message}`);
    return null;
  }
}

async function processPersonPhotos(personData) {
  if (!personData.photos || personData.photos.length === 0) {
    return null;
  }

  let bestAvatar = null;
  let foundFace = false;

  // Try ALL photos and prefer ones with detected faces
  for (let i = 0; i < personData.photos.length; i++) {
    const photoPath = personData.photos[i];
    const fullPath = path.join(rootDir, photoPath);

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      console.log(`  Photo not found: ${photoPath}`);
      continue;
    }

    // Try to create avatar
    const result = await createAvatar(fullPath, personData.id, i);

    if (result) {
      // If this photo has a face, use it immediately
      if (result.hasFace) {
        console.log(`  Found face in photo ${i + 1}/${personData.photos.length}`);
        return result;
      }

      // Otherwise, keep it as backup if we don't have one yet
      if (!bestAvatar) {
        bestAvatar = result;
      }
    }
  }

  // Return the best avatar we found (with face preferred, or fallback to smart crop)
  return bestAvatar;
}

async function generateAvatars() {
  console.log('Starting avatar generation with face detection...\n');

  // Create avatar directory
  if (!fs.existsSync(AVATAR_DIR)) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
  }

  // Load face detection models
  await loadModels();
  console.log('');

  // Get all person JSON files
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && f !== 'index.json');

  console.log(`Found ${files.length} people to process\n`);

  let processedCount = 0;
  let avatarCount = 0;
  let facesDetected = 0;

  for (const file of files) {
    const personPath = path.join(DATA_DIR, file);
    const personData = JSON.parse(fs.readFileSync(personPath, 'utf-8'));

    processedCount++;

    if (personData.photos && personData.photos.length > 0) {
      console.log(`[${processedCount}/${files.length}] Processing ${personData.name}...`);

      const result = await processPersonPhotos(personData);

      if (result) {
        // Update person data with avatar
        personData.avatar = result.path;
        fs.writeFileSync(personPath, JSON.stringify(personData, null, 2));
        avatarCount++;

        if (result.hasFace) {
          facesDetected++;
          console.log(`  ✓ Created avatar with face detection: ${result.path}`);
        } else {
          console.log(`  ✓ Created avatar (no face detected, using smart crop): ${result.path}`);
        }
      }

      console.log('');
    } else {
      if (processedCount % 50 === 0) {
        console.log(`[${processedCount}/${files.length}] Processed...`);
      }
    }
  }

  console.log(`\n✓ Complete!`);
  console.log(`  Processed: ${processedCount} people`);
  console.log(`  Created: ${avatarCount} avatars`);
  console.log(`  Faces detected: ${facesDetected} (${Math.round(facesDetected / avatarCount * 100)}%)`);
  console.log(`  Smart crop fallback: ${avatarCount - facesDetected}`);
}

// Run the script
generateAvatars().catch(error => {
  console.error('Error generating avatars:', error);
  process.exit(1);
});
