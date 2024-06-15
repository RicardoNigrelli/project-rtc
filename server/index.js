import express from "express";
import logger from "morgan";
import { Server } from "socket.io";
import { createServer } from "node:http";
import { createClient } from "@libsql/client";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const port = process.env.PORT || 3000;
const app = express();
const server = createServer(app);
const io = new Server(server, {
  connectionStateRecovery: {},
});

const db = createClient({
  url: "libsql://joint-rapture-ricardonigrelli.turso.io",
  authToken: process.env.DB_TOKEN,
});

await db.execute(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,
    user TEXT)`);

await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT)`);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "../client")));

app.use(logger("dev"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

io.on("connection", async (socket) => {
  console.log("User connected");

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });

  socket.on("chat message", async (msg) => {
    let result;
    const username = socket.handshake.auth.username ?? "anonymous";
    try {
      result = await db.execute({
        sql: `INSERT INTO messages (content, user) VALUES (:msg, :username)`,
        args: { msg, username},
      });
    } catch (e) {
      console.error(e);
      return;
    }
    io.emit("chat message", msg, result.lastInsertRowid.toString(), username);
  });

  socket.on("register", async ({ username, password }) => {
    try {
      const existingUser = await db.execute({
        sql: `SELECT * FROM users WHERE username = :username`,
        args: { username },
      });

      if (existingUser.rows.length > 0) {
        socket.emit("register", {
          success: false,
          message: "Username already taken",
        });
        console.log(`Registration failed: Username ${username} already taken`);
        return;
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await db.execute({
        sql: `INSERT INTO users (username, password) VALUES (:username, :password)`,
        args: { username, password: hashedPassword },
      });
      socket.emit("register", { success: true });
      console.log(
        `User ${username} registered with id ${result.lastInsertRowid}`
      );
    } catch (error) {
      console.error(error);
      socket.emit("register", {
        success: false,
        message: "Registration failed",
      });
    }
  });

  socket.on("login", async ({ username, password }) => {
    try {
      const result = await db.execute({
        sql: `SELECT * FROM users WHERE username = :username`,
        args: { username },
      });

      if (result.rows.length === 0) {
        socket.emit("login", { success: false, message: "User not found" });
        console.log(`User ${username} not found`);
        return;
      }

      const user = result.rows[0];

      const passwordMatches = await bcrypt.compare(password, user.password);
      if (passwordMatches) {
        socket.emit("login", { success: true });
        console.log(`User ${username} logged in`);
      } else {
        socket.emit("login", { success: false, message: "Invalid password" });
        console.log(`User ${username} login failed`);
      }
    } catch (error) {
      console.error(error);
      socket.emit("login", { success: false, message: "Login failed" });
    }
  });

  if (!socket.recovered) {
    try {
      const results = await db.execute({
        sql: "SELECT id, content, user FROM messages WHERE id > ?",
        args: [socket.handshake.auth.serverOffset ?? 0]
      })

      results.rows.forEach(row => {
        socket.emit("chat message", row.content, row.id.toString(), row.username);
      });

    } catch (error) {
      console.error(error);
    }
  }

});
