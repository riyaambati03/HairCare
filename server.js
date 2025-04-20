const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const cron = require("node-cron");

const User = require("./models/User");
const CarePlan = require("./models/CarePlan");
const Progress = require("./models/Progress");
const { generateCarePlanFetch } = require("./gemini-fetch");

dotenv.config();

mongoose.set("strictQuery", true);
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(session({
  secret: "haircare_secret",
  resave: false,
  saveUninitialized: true,
}));

const pdfDir = path.join(__dirname, "public", "pdfs");
if (!fs.existsSync(pdfDir)) {
  fs.mkdirSync(pdfDir, { recursive: true });
}

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log("MongoDB Error:", err));

const sendEmailWithAttachment = async (email, username, filePath) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: `"HairCare Pro" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Your HairCare Pro Prescription",
    text: `Hi ${username},\n\nAttached is your personalized hair care prescription.\n\nTake care,\nHairCare Pro`,
    attachments: [
      {
        filename: "HairCare_Prescription.pdf",
        path: filePath,
      },
    ],
  };

  await transporter.sendMail(mailOptions);
};

const sendReminderEmail = async (user, carePlan) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: `"HairCare Pro" <${process.env.EMAIL_USER}>`,
    to: user.email,
    subject: "HairCare Reminder 💧",
    text: `Hi ${user.username},\n\nThis is your friendly reminder to follow your hair care routine!\n\nRecommended wash frequency: ${carePlan.washFrequency}\n\nTips:\n${carePlan.tips?.map(t => `- ${t}`).join("\n")}\n\nTake care,\nHairCare Pro`
  };

  await transporter.sendMail(mailOptions);
};

app.get("/", (req, res) => res.redirect("/login"));

app.get("/login", (req, res) => res.render("login"));

app.get("/register", (req, res) => res.render("register"));

app.post("/register", async (req, res) => {
  const { username, email, password } = req.body;
  const existing = await User.findOne({ $or: [{ username }, { email }] });
  if (existing) {
    return res.send("Username or email already exists.");
  }

  const user = new User({ username, email, password });
  await user.save();
  res.redirect("/login");
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username, password });
  if (user) {
    req.session.user = {
      _id: user._id,
      username: user.username,
      email: user.email
    };
    res.redirect("/survey");
  } else {
    res.send("Invalid credentials");
  }
});

app.get("/survey", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("survey", { username: req.session.user.username });
});

app.post("/survey", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const surveyData = req.body;
  const carePlan = await generateCarePlanFetch(surveyData, process.env.GEMINI_API_KEY);
  const userId = req.session.user._id;

  const carePlanDoc = new CarePlan({ userId, surveyData, carePlan });
  await carePlanDoc.save();

  const fileName = `careplan_${userId}_${Date.now()}.pdf`;
  const filePath = path.join(pdfDir, fileName);
  const publicPath = `/pdfs/${fileName}`;

  const pdf = new PDFDocument();
  pdf.pipe(fs.createWriteStream(filePath));

  pdf.fontSize(28).fillColor('#1E90FF').text("HairCare Pro", { align: "center" });
  pdf.moveDown(0.5);
  pdf.fontSize(16).fillColor('#000').text(`This prescription is made for ${req.session.user.username}`, { align: "center" });
  pdf.moveDown(1.5);

  pdf.fontSize(14).text(`Recommended Wash Frequency: ${carePlan.washFrequency}`).moveDown();

  pdf.text("Ingredients:");
  carePlan.ingredients.forEach(i => {
    pdf.text(`- ${i}: ${carePlan.instructions[i] || "No instructions"}`);
  });
  pdf.moveDown();

  pdf.text("Tips:");
  carePlan.tips?.forEach(tip => pdf.text(`- ${tip}`));
  pdf.end();

  await sendEmailWithAttachment(req.session.user.email, req.session.user.username, filePath);

  res.render("result", {
    username: req.session.user.username,
    email: req.session.user.email,
    ingredients: carePlan.ingredients || [],
    washFrequency: carePlan.washFrequency || "Not specified",
    instructions: carePlan.instructions || {},
    tips: carePlan.tips || [],
    resources: carePlan.resources || [],
    rawResponse: carePlan.rawResponse || {},
    error: carePlan.error,
    pdfPath: publicPath
  });
});

app.get("/dashboard", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const userId = req.session.user._id;

  // Fetch care plan
  const latestCarePlan = await CarePlan.findOne({ userId }).sort({ createdAt: -1 });

  let alertMessage = null;
  if (latestCarePlan) {
    const frequency = latestCarePlan.carePlan.washFrequency || "";
    const createdAt = latestCarePlan.createdAt;
    let days = 0;

    // Parse frequency to days
    if (/1-2/i.test(frequency)) days = 3;
    else if (/2-3/i.test(frequency)) days = 2;
    else if (/daily|every day/i.test(frequency)) days = 1;
    else days = 4; // fallback

    const nextReminder = new Date(createdAt);
    nextReminder.setDate(nextReminder.getDate() + days);

    const today = new Date();
    if (today.toDateString() === nextReminder.toDateString()) {
      alertMessage = `Hey ${req.session.user.username}, it's time to follow your hair care routine!`;
    }
  }

  const progress = await Progress.find({ userId }).sort({ step: 1 });
  res.render("dashboard", {
    username: req.session.user.username,
    email: req.session.user.email,
    progress,
    alertMessage
  });
});



app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Cron job to send reminders daily at 9 AM
cron.schedule("0 9 * * *", async () => {
  console.log("⏰ Running daily reminder check...");

  const allCarePlans = await CarePlan.find({}).populate("userId");

  for (const plan of allCarePlans) {
    const user = plan.userId;
    if (!user || !user.email) continue;

    const freq = plan.carePlan?.washFrequency || "";
    const match = freq.match(/(\d)-?(\d)?\s*(?:times)?\/?week/i);
    if (!match) continue;

    const min = parseInt(match[1]);
    const max = match[2] ? parseInt(match[2]) : min;
    const avgDays = Math.round(7 / ((min + max) / 2));

    const lastSent = plan.lastReminderSent || plan.createdAt;
    const now = new Date();
    const diffDays = Math.floor((now - lastSent) / (1000 * 60 * 60 * 24));

    if (diffDays >= avgDays) {
      console.log(`📨 Sending reminder to ${user.email}`);
      await sendReminderEmail(user, plan.carePlan);
      plan.lastReminderSent = new Date();
      await plan.save();
    }
  }
});

app.listen(process.env.PORT || 3000, process.env.HOST || "0.0.0.0", () => {
  console.log(`Server running on http://${process.env.HOST || "localhost"}:${process.env.PORT || 3000}`);
});