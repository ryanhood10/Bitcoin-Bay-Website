const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();
const dotenv = require('dotenv');
// At the top of your server.js, add:
const { parse } = require('csv-parse/sync');

// Load environment variables from .env file
dotenv.config();

// Enable CORS for all routes
app.use(cors());

// Serve static files
app.use(express.static(path.join(__dirname)));

// Middleware to parse JSON bodies
app.use(bodyParser.json());

// Serve your index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// Define route for HowTo
app.get('/HowTo', (req, res) => {
  res.sendFile(path.join(__dirname, 'howto.html'));
});

// Define route for Leaderboard
app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'leaderboard.html'));
});

// Email sending route
app.post('/send-email', (req, res) => {
  const { firstName, lastName, email, phone, promo } = req.body;

  // Create a transporter object
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL,
      pass: process.env.PASSWORD,
    }
  });

  // Email options
  const mailOptions = {
    from: process.env.EMAIL,
    to: 'bitcoinbaynotifications@gmail.com',
    subject: 'New Account Created',
    text: `First Name: ${firstName}\nLast Name: ${lastName}\nEmail: ${email}\nPhone: ${phone}\nReferred By: ${promo}`
  };

  // Send the email
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log('Error sending email:', error);
      res.status(500).send('Error sending email');
    } else {
      console.log('Email sent:', info.response);
      res.status(200).send('Email sent successfully');
    }
  });
});


// New API route for Leaderboard data using csv-parse in array mode
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const googleSheetUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQhLDCWHWkHOWYMRGoCc9CP3tHyt04d_CIRf5ydJFqo0rbAQ6Wu45XzCwyaRgElVeile0Noe3BM-vDh/pub?output=csv';
    const response = await fetch(googleSheetUrl);
    const csvText = await response.text();
    console.log('CSV Text:', csvText);

    // Parse CSV data into an array of arrays
    const records = parse(csvText, {
      skip_empty_lines: true,
      trim: true
    });
    console.log('Records (array of arrays):', records);

    // Extract subheading from cell G18 and user date from cell G19
    const subheading = (records.length >= 18 && records[17].length >= 7) ? records[17][6].trim() : "";
    const userDate = (records.length >= 19 && records[18].length >= 7) ? records[18][6].trim() : "";    
    

    console.log('Subheading (G18):', subheading);
    console.log('User Date (G19):', userDate);

    // Process data for leaderboard as before…
    const header = records[0].slice(0, 3);
    console.log('Header:', header);

    const dataRows = records.slice(1).map(row => ({
      ID: row[0] ? row[0].trim() : '',
      Count: row[1] ? row[1].trim() : '',
      Volume: row[2] ? row[2].trim() : ''
    }));
    console.log('Data Rows:', dataRows);

    const validData = dataRows.filter(row => {
      if (!row.Volume) return false;
      const vol = parseFloat(row.Volume.replace(/,/g, ''));
      return !isNaN(vol);
    });
    console.log('Valid Data:', validData);

    validData.sort((a, b) => {
      return parseFloat(b.Volume.replace(/,/g, '')) - parseFloat(a.Volume.replace(/,/g, ''));
    });
    console.log('Sorted Data:', validData);

    const topCount = Math.floor(validData.length * 0.2);
    console.log('Total valid rows:', validData.length, 'Top count:', topCount);

    const topRows = validData.slice(0, topCount);
    console.log('Top 20% Rows:', topRows);

    const leaderboardIDs = topRows.map(row => row.ID);
    console.log('Leaderboard IDs:', leaderboardIDs);

    const volumeNeeded = topRows[topRows.length - 1].Volume;
    console.log('Volume Needed to Enter top 20%:', volumeNeeded);

    res.json({ 
      leaderboard: leaderboardIDs, 
      volumeNeeded: volumeNeeded,
      subheading: subheading,
      userDate: userDate
    });
  } catch (error) {
    console.error('Error retrieving leaderboard data:', error);
    res.status(500).json({ error: 'Error retrieving leaderboard data' });
  }
});






// Start server
const PORT = process.env.PORT || 8800;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
