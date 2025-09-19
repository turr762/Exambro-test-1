import express from "express";
import cors from "cors";
import multer from "multer";
import Database from "better-sqlite3";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { Parser } from "json2csv";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// File upload (soal berupa gambar)
const upload = multer({ dest: "uploads/" });

// ===== Database =====
const db = new Database("db.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER,
  title TEXT,
  code TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER,
  text TEXT,
  image TEXT,
  correct TEXT
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT,
  class TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER,
  student_id INTEGER,
  switch_count INTEGER DEFAULT 0,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER,
  question_id INTEGER,
  chosen TEXT
);
`);

// ===== Helper functions =====
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function authTeacher(req, res, next) {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).send("No token");
  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.teacher = decoded;
    next();
  } catch {
    return res.status(401).send("Invalid token");
  }
}

function all(sql, params = []) {
  return db.prepare(sql).all(params);
}
function get(sql, params = []) {
  return db.prepare(sql).get(params);
}
function run(sql, params = []) {
  return db.prepare(sql).run(params);
}

// ===== Routes Guru =====

// Register guru
app.post("/api/teacher/register", async (req, res) => {
  const { username, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  try {
    run("INSERT INTO teachers(username,password) VALUES(?,?)", [username, hashed]);
    res.send("Guru berhasil dibuat");
  } catch {
    res.status(400).send("Username sudah ada");
  }
});

// Login guru
app.post("/api/teacher/login", async (req, res) => {
  const { username, password } = req.body;
  const teacher = get("SELECT * FROM teachers WHERE username=?", [username]);
  if (!teacher) return res.status(400).send("Guru tidak ditemukan");
  const ok = await bcrypt.compare(password, teacher.password);
  if (!ok) return res.status(400).send("Password salah");
  const token = jwt.sign({ id: teacher.id, username: teacher.username }, JWT_SECRET);
  res.json({ token });
});

// Buat ujian
app.post("/api/exams", authTeacher, (req, res) => {
  const { title } = req.body;
  const code = generateCode();
  run("INSERT INTO exams(teacher_id,title,code) VALUES(?,?,?)", [req.teacher.id, title, code]);
  res.send("Ujian dibuat");
});

// Daftar ujian guru
app.get("/api/exams", authTeacher, (req, res) => {
  const exams = all("SELECT * FROM exams WHERE teacher_id=?", [req.teacher.id]);
  res.json(exams);
});

// Tambah soal
app.post("/api/exams/:examId/questions", authTeacher, upload.single("image"), (req, res) => {
  const { text, correct } = req.body;
  const examId = req.params.examId;
  const image = req.file ? "/uploads/" + req.file.filename : null;
  run("INSERT INTO questions(exam_id,text,image,correct) VALUES(?,?,?,?)", [
    examId,
    text,
    image,
    correct,
  ]);
  res.send("Soal ditambah");
});

// ===== Routes Siswa =====

// Join ujian
app.post("/api/join", (req, res) => {
  const { name, email, class: kelas, code } = req.body;
  const exam = get("SELECT * FROM exams WHERE code=?", [code]);
  if (!exam) return res.status(400).send("Kode salah");

  let student = get("SELECT * FROM students WHERE email=?", [email]);
  if (!student) {
    const r = run("INSERT INTO students(name,email,class) VALUES(?,?,?)", [name, email, kelas]);
    student = { id: r.lastInsertRowid };
  }

  const attempt = run("INSERT INTO attempts(exam_id,student_id) VALUES(?,?)", [
    exam.id,
    student.id,
  ]);

  res.json({ attemptId: attempt.lastInsertRowid, examId: exam.id });
});

// Ambil soal
app.get("/api/exams/:examId/questions", (req, res) => {
  const q = all("SELECT * FROM questions WHERE exam_id=?", [req.params.examId]);
  res.json(q);
});

// Jawab soal
app.post("/api/answer", (req, res) => {
  const { attemptId, qid, ans } = req.body;
  const existing = get("SELECT * FROM answers WHERE attempt_id=? AND question_id=?", [
    attemptId,
    qid,
  ]);
  if (existing) {
    run("UPDATE answers SET chosen=? WHERE id=?", [ans, existing.id]);
  } else {
    run("INSERT INTO answers(attempt_id,question_id,chosen) VALUES(?,?,?)", [
      attemptId,
      qid,
      ans,
    ]);
  }
  res.send("Tersimpan");
});

// ===== Hasil & Export =====

// Hasil ujian untuk guru
app.get("/api/exams/:examId/results", authTeacher, (req, res) => {
  const examId = req.params.examId;
  const exam = get("SELECT * FROM exams WHERE id=? AND teacher_id=?", [examId, req.teacher.id]);
  if (!exam) return res.status(404).send("Not found");

  const attempts = all(
    `SELECT a.id as attemptId, s.name, s.email, s.class
     FROM attempts a JOIN students s ON a.student_id=s.id
     WHERE a.exam_id=?`,
    [examId]
  );

  const results = attempts.map((at) => {
    const answers = all(
      "SELECT a.chosen, q.correct FROM answers a JOIN questions q ON a.question_id=q.id WHERE a.attempt_id=?",
      [at.attemptId]
    );
    const total = all("SELECT id FROM questions WHERE exam_id=?", [examId]).length;
    let score = 0;
    answers.forEach((r) => {
      if (r.chosen === r.correct) score++;
    });
    return { name: at.name, email: at.email, class: at.class, score, total };
  });

  res.json(results);
});

// Export CSV
app.get("/api/exams/:examId/export/csv", authTeacher, (req, res) => {
  const { examId } = req.params;
  const attempts = all(
    `SELECT a.id as attemptId, s.name, s.email, s.class
     FROM attempts a JOIN students s ON a.student_id=s.id
     WHERE a.exam_id=?`,
    [examId]
  );

  const rows = attempts.map((at) => {
    const answers = all(
      "SELECT a.chosen, q.correct FROM answers a JOIN questions q ON a.question_id=q.id WHERE a.attempt_id=?",
      [at.attemptId]
    );
    const total = all("SELECT id FROM questions WHERE exam_id=?", [examId]).length;
    let correct = 0;
    answers.forEach((r) => {
      if (r.chosen === r.correct) correct++;
    });
    return {
      name: at.name,
      email: at.email,
      class: at.class,
      correct,
      total,
      percent: total ? Math.round((correct / total) * 100) : 0,
    };
  });

  const parser = new Parser();
  const csv = parser.parse(rows);
  res.setHeader("Content-Disposition", "attachment; filename=hasil.csv");
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

// Export Excel
app.get("/api/exams/:examId/export/xlsx", authTeacher, async (req, res) => {
  const { examId } = req.params;
  const attempts = all(
    `SELECT a.id as attemptId, s.name, s.email, s.class
     FROM attempts a JOIN students s ON a.student_id=s.id
     WHERE a.exam_id=?`,
    [examId]
  );

  const rows = attempts.map((at) => {
    const answers = all(
      "SELECT a.chosen, q.correct FROM answers a JOIN questions q ON a.question_id=q.id WHERE a.attempt_id=?",
      [at.attemptId]
    );
    const total = all("SELECT id FROM questions WHERE exam_id=?", [examId]).length;
    let correct = 0;
    answers.forEach((r) => {
      if (r.chosen === r.correct) correct++;
    });
    return {
      name: at.name,
      email: at.email,
      class: at.class,
      correct,
      total,
      percent: total ? Math.round((correct / total) * 100) : 0,
    };
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Hasil");
  ws.columns = Object.keys(rows[0] || { name: "", email: "", class: "", correct: 0 }).map((k) => ({
    header: k,
    key: k,
    width: 20,
  }));
  rows.forEach((r) => ws.addRow(r));
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", "attachment; filename=hasil.xlsx");
  await wb.xlsx.write(res);
  res.end();
});

// Export PDF
app.get("/api/exams/:examId/export/pdf", authTeacher, (req, res) => {
  const { examId } = req.params;
  const attempts = all(
    `SELECT a.id as attemptId, s.name, s.email, s.class
     FROM attempts a JOIN students s ON a.student_id=s.id
     WHERE a.exam_id=?`,
    [examId]
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=hasil.pdf");

  const doc = new PDFDocument({ margin: 30 });
  doc.pipe(res);
  doc.fontSize(16).text("Hasil Ujian", { align: "center" });
  doc.moveDown();

  attempts.forEach((at) => {
    const answers = all(
      "SELECT a.chosen, q.correct FROM answers a JOIN questions q ON a.question_id=q.id WHERE a.attempt_id=?",
      [at.attemptId]
    );
    const total = all("SELECT id FROM questions WHERE exam_id=?", [examId]).length;
    let correct = 0;
    answers.forEach((r) => {
      if (r.chosen === r.correct) correct++;
    });
    doc
      .fontSize(12)
      .text(
        `${at.name} | ${at.email} | kelas: ${at.class} | skor: ${correct}/${total} (${total ? Math.round((correct / total) * 100) : 0}%)`
      );
  });

  doc.end();
});

// ===== Start Server =====
app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});
