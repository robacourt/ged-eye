import canvas from 'canvas';
import * as faceapi from '@vladmandic/face-api';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Setup face-api to use node-canvas
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODEL_DIR = path.join(rootDir, 'node_modules', '@vladmandic', 'face-api', 'model');

async function testFace() {
  console.log('Loading models...');
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_DIR);
  console.log('Models loaded!\n');

  const testImages = [
    'Data/Picture/Ian A\'Court 2003.jpg',
    'Data/Media/Barnett 1.jpg',
    'Data/Media/Bob-A\'Court.jpg',
    'Data/Media/cff93e8f-2055-4c3c-b48e-8eb005e234b2.jpg'
  ];

  for (const testImagePath of testImages) {
    const testImage = path.join(rootDir, testImagePath);
    console.log(`\nTesting: ${testImagePath}`);

    try {
      const img = await canvas.loadImage(testImage);
      console.log(`  Image size: ${img.width}x${img.height}`);

      // Try both detectors
      console.log('  Testing SSD MobileNet...');
      const detections1 = await faceapi.detectAllFaces(img);
      console.log(`    Found ${detections1.length} faces`);

      console.log('  Testing Tiny Face Detector...');
      const detections2 = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions());
      console.log(`    Found ${detections2.length} faces`);

      const detections = detections2.length > 0 ? detections2 : detections1;
      if (detections.length > 0) {
        detections.forEach((det, i) => {
          console.log(`\n  Face ${i + 1}:`);
          console.log(`    Position: (${Math.round(det.box.x)}, ${Math.round(det.box.y)})`);
          console.log(`    Size: ${Math.round(det.box.width)}x${Math.round(det.box.height)}`);
          if (det.score) console.log(`    Confidence: ${(det.score * 100).toFixed(1)}%`);
        });
      }
    } catch (error) {
      console.log(`  Error: ${error.message}`);
    }
  }
}

testFace().catch(console.error);
