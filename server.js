require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const path = require("path");
const app = express();
const server = http.createServer(app);

const Message = require("./models/Message");
// 🔥 MongoDB 연결
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB 연결 성공"))
  .catch(err => console.log("❌ MongoDB 연결 실패:", err));

// 테스트용
app.get("/", (req, res) => {
  res.send("서버 정상 작동");
});
app.use(express.static(path.join(__dirname, "public")));
// Socket
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

io.on("connection", (socket) => {
  console.log("유저 접속:", socket.id);

  socket.on("chat:send", async (msg) => {
    // 🔥 DB 저장
    const saved = await Message.create({
      sender: msg.sender,
      text: msg.text
    });

    // 🔥 저장된 데이터로 보내기
    io.emit("chat:receive", saved);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 서버 실행중: ${PORT}`);
});