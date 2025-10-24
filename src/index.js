import express from "express";
import cors from "cors";
import "dotenv/config";
import http from "http";
import { Server } from "socket.io";
import NodeCache from "node-cache";

import job from "./lib/cron.js";
import { connectDB } from "./lib/db.js";
import { verifySocketToken } from "./middleware/socketAuth.js";

// Routes
import authRoutes from "./routes/authRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";

// Models
import Chat from "./models/Chat.js";
import Message from "./models/Message.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
job.start();
connectDB();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cors({ origin: "*" }));

// ---------- Routes ----------
app.use("/api/auth", authRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/chats", chatRoutes);

// ---------- Server & Socket ----------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket"], // Render requires websocket
});

// ---------- Caching ----------
const chatCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // cache for 5 minutes

// ---------- Socket Authentication ----------
io.use(verifySocketToken);

// ---------- Socket Events ----------
io.on("connection", async (socket) => {
  console.log(`User connected: ${socket.userId}`);

  // Join all chat rooms user participates in
  try {
    let userChats = chatCache.get(`userChats:${socket.userId}`);
    if (!userChats) {
      userChats = await Chat.find({ participants: socket.userId }).select("_id");
      chatCache.set(`userChats:${socket.userId}`, userChats);
    }
    userChats.forEach(chat => socket.join(chat._id.toString()));
  } catch (err) {
    console.error("Error joining chat rooms:", err);
  }

  // -------- Send Message --------
  socket.on("sendMessage", async ({ receiverId, content, messageType = "text" }) => {
    try {
      if (!receiverId || !content?.trim()) return socket.emit("socketError", { message: "Invalid message data" });
      if (content.length > 5000) return socket.emit("socketError", { message: "Message too long" });

      // Find or create chat
      let chatKey = `chat:${[socket.userId, receiverId].sort().join(":")}`;
      let chat = chatCache.get(chatKey);
      if (!chat) {
        chat = await Chat.findOne({ participants: { $all: [socket.userId, receiverId] } });
        if (!chat) {
          chat = await Chat.create({ participants: [socket.userId, receiverId] });
        }
        chatCache.set(chatKey, chat);
      }

      socket.join(chat._id.toString());

      // Create message
      const message = await Message.create({
        chatId: chat._id,
        sender: socket.userId,
        content: content.trim(),
        messageType,
      });

      await message.populate("sender", "username profileImage");

      // Update chat last message
      chat.lastMessage = message._id;
      chat.updatedAt = Date.now();
      await chat.save();
      chatCache.set(chatKey, chat);

      // Emit to all participants
      io.to(chat._id.toString()).emit("receiveMessage", { message, chat });

      socket.emit("messageSent", { message, chat });

    } catch (err) {
      console.error("sendMessage error:", err);
      socket.emit("socketError", { message: "Failed to send message" });
    }
  });

  // -------- Delete Message --------
  socket.on("deleteMessage", async ({ messageId }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return socket.emit("socketError", { message: "Message not found" });
      if (message.sender.toString() !== socket.userId) return socket.emit("socketError", { message: "Not authorized" });

      const chatId = message.chatId;
      await message.deleteOne();

      const chat = await Chat.findById(chatId);
      if (chat.lastMessage?.toString() === messageId) {
        const lastMsg = await Message.findOne({ chatId }).sort({ createdAt: -1 });
        chat.lastMessage = lastMsg?._id || null;
        await chat.save();
      }

      io.to(chatId.toString()).emit("messageDeleted", { messageId, chatId });

    } catch (err) {
      console.error("deleteMessage error:", err);
      socket.emit("socketError", { message: "Failed to delete message" });
    }
  });

  // -------- Typing Indicator --------
  socket.on("typing", ({ chatId, isTyping }) => {
    if (!chatId) return;
    socket.to(chatId.toString()).emit("userTyping", { senderId: socket.userId, chatId, isTyping });
  });

  // -------- Seen Messages --------
  socket.on("seenMessage", async ({ chatId }) => {
    try {
      if (!chatId) return;
      const chat = await Chat.findById(chatId);
      if (!chat || !chat.participants.includes(socket.userId)) return;

      const result = await Message.updateMany(
        { chatId, sender: { $ne: socket.userId }, seenBy: { $ne: socket.userId } },
        { $addToSet: { seenBy: socket.userId } }
      );

      if (result.modifiedCount > 0) {
        io.to(chatId.toString()).emit("messagesSeen", { userId: socket.userId, chatId });
      }

    } catch (err) {
      console.error("seenMessage error:", err);
    }
  });

  // -------- Heartbeat (optional) --------
  const heartbeat = setInterval(() => {
    socket.emit("ping", { time: Date.now() });
  }, 10000);

  socket.on("disconnect", () => {
    clearInterval(heartbeat);
    console.log(`User disconnected: ${socket.userId}`);
  });
});

// ---------- Start Server ----------
server.listen(PORT,  () => console.log(`Server running on port ${PORT}`));
