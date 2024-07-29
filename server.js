const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const app = express();
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

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

// Email sending route
app.post('/send-email', (req, res) => {
  const { firstName, lastName, email, phone, promo } = req.body;

  // Create a transporter object
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL,
      // user: "bitcoinbaynotifications@gmail.com",
      pass: process.env.PASSWORD,
      // pass: "bdps rlea hgtw lygc",

    }
  });

  // Email options
  const mailOptions = {
    from: process.env.EMAIL,
    to: 'bitcoinbaynotifications@gmail.com', // Replace with the recipient's email 
    subject: 'New Account Created',
    text: `First Name: ${firstName}\nLast Name: ${lastName}\nEmail: ${email}\nPhone: ${phone}\nPromo Code: ${promo}`
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
