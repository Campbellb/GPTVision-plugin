const express = require("express");
const cors = require("cors");
const fs = require("fs");
const app = express();
const port = 5008;
const puppeteer = require('puppeteer');
const path = require('path');
const Replicate = require('replicate');
const axios = require('axios');

app.use(express.json());
app.use(cors({ origin: "https://chat.openai.com" }));

const replicate = new Replicate({
  auth: 'bffba06c22e423bd1f0d1faa0f2be8e3578ded96',
});

let imagePath = null;
let caption = null;
let browser = null;
let page = null;
app.use('/images', express.static(path.join(__dirname, 'images')));

app.post("/openUrl", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).send({ error: 'URL is required.' });
  }

  try {
    console.log('Opening URL: ', url);
    browser = await puppeteer.launch({ headless: false });
    page = await browser.newPage();
    await page.goto(url);

    return res.status(200).send({ message: 'URL opened successfully.' });
  } catch (error) {
    console.error(error);
    return res.status(500).send({ error: 'Failed to open the URL.' });
  }
});

app.post('/runCommand', async (req, res) => {
  try {
    console.log('running command', req.body)
    if (!page || !browser) {
      return res.status(400).send('No browser or page available. Please open a URL first');
    }

    const command = req.body.command;
    const selector = req.body.selector;

    if (!command || !selector) {
      return res.status(400).send('Please provide a command and a selector');
    }

    let result;
    switch (command) {
      case 'click':
        await page.click(selector);
        result = `Clicked on ${selector}`;
        break;
      case 'type':
        const text = req.body.text;
        if (!text) {
          return res.status(400).send('Please provide text for the type command');
        }
        await page.type(selector, text);
        result = `Typed "${text}" into ${selector}`;
        break;
      case 'evaluate':
        const script = req.body.script;
        if (!script) {
          return res.status(400).send('Please provide a script for the evaluate command');
        }
        const evaluationResult = await page.$eval(selector, (element, script) => {
          return eval(script);
        }, script);
        result = { message: `Evaluated script on ${selector}`, data: evaluationResult };
        break;
      default:
        return res.status(400).send('Invalid command');
    }

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error running command');
  }
});

app.get("/.well-known/ai-plugin.json", (req, res) => {
  console.log("Trying to load plugin.json");
  const host = req.headers.host;
  fs.readFile("./.well-known/ai-plugin.json", (err, buf) => {
    let text = buf.toString();
    if (err) {
      res.status(404).send("Not found");
    } else {
      text = text.replace("PLUGIN_HOSTNAME", `http://${host}`);
      res.status(200).type("text/json").send(text);
    }
  });
});

app.post('/takePicture', async (req, res) => {
  const browser = await puppeteer.launch({
    headless: false, // Open the browser in non-headless mode
  });

  const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, 'capture.html'));

  const photoBuffer = await page.evaluate(async () => {
    const video = document.getElementById('video');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;

    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    await new Promise((resolve) => (video.onloadedmetadata = resolve));
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataURL = canvas.toDataURL('image/jpeg');
    return dataURL.replace(/^data:image\/\w+;base64,/, '');
  });

  // Create a new page and set the captured image as the content
  const displayPage = await browser.newPage();
  const imageDataURI = `data:image/jpeg;base64,${photoBuffer}`;
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Display Captured Photo</title>
      </head>
      <body>
        <img src="${imageDataURI}" alt="Captured Photo">
      </body>
    </html>
  `;
  await displayPage.setContent(htmlContent);

  // Save the image to a temporary file
  imagePath = path.join(__dirname, 'temp_image.jpg');
  await fs.promises.writeFile(imagePath, photoBuffer, 'base64');

  // Read the image file and convert it to a base64 string
  const fileBuffer = await fs.promises.readFile(imagePath);
  const base64Image = fileBuffer.toString('base64');

  // Use the Replicate API to process the image
  const output = await replicate.run(
    "salesforce/blip:2e1dddc8621f72155f24cf2e0adbde548458d3cab9f00c0139eea840d0ac4746",
    {
      input: {
        image: `data:image/jpeg;base64,${base64Image}`,
      },
    },
  );

  // Remove the temporary image file
  // await fs.promises.unlink(imagePath);
  browser.close();
  caption = output.startsWith("Caption:") ? output.replace("Caption:", "").trim() : output;
  res.status(200).json(caption);
});

app.post('/questionImage', async (req, res) => {
  const { question, url } = req.body;
  console.log('/questionImage', { question, url });

  if (!url && !imagePath) {
    return res.status(400).json({ error: 'Captured image is required' });
  }

  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  let fileBuffer;

  if (imagePath) {
    // Read the image file and convert it to a base64 string
    fileBuffer = await fs.promises.readFile(imagePath);
  } else {
    // Fetch the image from the URL and convert it to a base64 string
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    fileBuffer = Buffer.from(response.data, 'binary');
  }

  const base64Image = fileBuffer.toString('base64');

  try {
    const output = await replicate.run(
      'salesforce/blip:2e1dddc8621f72155f24cf2e0adbde548458d3cab9f00c0139eea840d0ac4746',
      {
        input: {
          image: `data:image/jpeg;base64,${base64Image}`,
          task: 'visual_question_answering',
          question,
        },
      },
    );

    res.status(200).json(output);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/refineImage', async (req, res) => {
  const { target, url } = req.body;

  if (!target) {
    return res.status(400).json({ error: 'Include target in body' });
  }

  if ((!imagePath && !url) || !caption) {
    return res.status(400).json({ error: 'Captured image is required' });
  }

  let fileBuffer;

  if (imagePath) {
    // Read the image file and convert it to a base64 string
    fileBuffer = await fs.promises.readFile(imagePath);
  } else {
    // Fetch the image from the URL and convert it to a base64 string
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    fileBuffer = Buffer.from(response.data, 'binary');
  }

  const base64Image = fileBuffer.toString('base64');
  const inputParams = {
    input: `data:image/jpeg;base64,${base64Image}`,
    neutral: caption, //caption from image
    target, // taken as input to api
    manipulationStrength: 5
  };

  console.log(inputParams);

  // Use the Replicate API to process the image
  const output = await replicate.run(
    "orpatashnik/styleclip:7af9a66f36f97fee2fece7dcc927551a951f0022cbdd23747b9212f23fc17021",
    {
      input: inputParams
    }
  );

  res.status(200).json(output);
});

app.post('/detectEmotion', async (req, res) => {
  if (!imagePath) {
    return res.status(400).json({ error: 'Captured image is required' });
  }

  // Read the image file and convert it to a base64 string
  const fileBuffer = await fs.promises.readFile(imagePath);
  const base64Image = fileBuffer.toString('base64');
  const inputParams = {
    input_path: `data:image/jpeg;base64,${base64Image}`,
  }
  console.log(inputParams)
  // Use the Replicate API to process the image
  const output = await replicate.run(
    "phamquiluan/facial-expression-recognition:b16694d5bfed43612f1bfad7015cf2b7883b732651c383fe174d4b7783775ff5",
    {
      input: inputParams
    }
  );

  res.status(200).json(output);
});



// app.post('/recordAudio', async (req, res) => {
//   const browser = await puppeteer.launch({ headless: false, args: [] });

//   const page = await browser.newPage();
//   await page.goto('file://' + path.join(__dirname, 'audio_capture.html'));

//   const audioArrayBuffer = await page.evaluate(async () => {
//     const startButton = document.getElementById('startButton');
//     const stopButton = document.getElementById('stopButton');

//     const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
//     const mediaRecorder = new MediaRecorder(stream);
//     const recordedChunks = [];

//     const startRecording = () => {
//       mediaRecorder.start();
//       startButton.disabled = true;
//       stopButton.disabled = false;
//     };

//     const stopRecording = () => {
//       mediaRecorder.stop();
//       startButton.disabled = false;
//       stopButton.disabled = true;
//     };

//     mediaRecorder.ondataavailable = (e) => {
//       if (e.data.size > 0) recordedChunks.push(e.data);
//     };

//     return new Promise((resolve) => {
//       mediaRecorder.onstop = () => {
//         const audioBuffer = new Blob(recordedChunks, { type: 'audio/webm' });
//         const reader = new FileReader();

//         reader.onloadend = () => {
//           window.recordingStopped = true;
//           resolve(reader.result);
//         };
//         reader.readAsArrayBuffer(audioBuffer);
//       };

//       startButton.onclick = startRecording;
//       stopButton.onclick = stopRecording;
//     });
//   });

//   // Wait for the recording to stop
//   await page.waitForFunction(() => window.recordingStopped);

//   // Close the browser
//   // await browser.close();
//   console.log('audioArrayBuffer', audioArrayBuffer)
//   // Convert the ArrayBuffer to a Buffer
//   const audioBuffer = Buffer.from(audioArrayBuffer);

//   // Save the WebM file to a temporary file
//   const tempWebmFile = 'temp.webm';
//   fs.writeFileSync(tempWebmFile, audioBuffer);

//   // Convert the WebM file to a WAV file using ffmpeg
//   const tempWavFile = 'temp.wav';
//   await execAsync(`ffmpeg -i ${tempWebmFile} ${tempWavFile}`);


// });

app.get("/openapi.yaml", (req, res) => {
  const host = req.headers.host;
  fs.readFile("openapi.yaml", "utf8", (err, buf) => {
    let text = buf.toString();
    if (err) {
      res.status(404).send("Not found");
    } else {
      text = text.replace("PLUGIN_HOSTNAME", `http://${host}`);
      res.status(200).type("text/yaml").send(text);
    }
  });
});

// app.get("/openapi.json", (req, res) => {
//   const host = req.headers.host;

//   fs.readFile("openapi.json", "utf8", (err, buf) => {
//     let text = buf.toString();
//     if (err) {
//       res.status(404).send("Not found");
//     } else {
//       text = text.replace("PLUGIN_HOSTNAME", `http://${host}`);

//       res.status(200).type("text/json").send(text);
//     }
//   });
// });

app.get("/logo.png", (req, res) => {
  res.sendFile("logo.png", { root: __dirname }, (err) => {
    if (err) res.status(404).send("Not found");
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
