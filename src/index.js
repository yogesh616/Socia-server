import express from "express";
import cors from "cors";
import "dotenv/config";
import http from "http";
import { Server } from "socket.io";
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
});

// ---------- Socket Authentication ----------
io.use(verifySocketToken);

// ---------- Socket Events ----------
// ---------- Socket Events ----------
io.on("connection", async (socket) => {
  console.log(`User connected: ${socket.userId}`);
  
  // Join personal room
  socket.join(socket.userId);
  
  // Join all chat rooms user is part of
  try {
    const userChats = await Chat.find({ participants: socket.userId });
    userChats.forEach(chat => {
      socket.join(chat._id.toString());
    });
  } catch (error) {
    console.error("Error joining chat rooms:", error);
  }

  // -------- Send Message --------
  socket.on("sendMessage", async ({ receiverId, content, messageType = "text" }) => {
    try {
      if (!receiverId || !content?.trim()) {
        return socket.emit("error", { message: "Invalid message data" });
      }

      // Validate content length
      if (content.length > 5000) {
        return socket.emit("error", { message: "Message too long" });
      }

      // Find or create chat
      let chat = await Chat.findOne({
        participants: { $all: [socket.userId, receiverId] },
      });

      if (!chat) {
        chat = await Chat.create({ participants: [socket.userId, receiverId] });
        // Both users should join this new chat room
        socket.join(chat._id.toString());
        io.to(receiverId).socketsJoin(chat._id.toString());
      }

      // Create message
      const message = await Message.create({
        chatId: chat._id,
        sender: socket.userId,
        content: content.trim(),
        messageType,
      });

      await message.populate("sender", "username profileImage");

      // Update chat's lastMessage
      chat.lastMessage = message._id;
      chat.updatedAt = Date.now();
      await chat.save();

      // Populate chat for frontend
      await chat.populate("participants", "username profileImage email");
      await chat.populate("lastMessage");

      // Emit to receiver
      io.to(receiverId).emit("receiveMessage", {
        message,
        chat, // Include updated chat
      });

      // Confirm to sender
      socket.emit("messageSent", {
        message,
        chat,
      });
    } catch (error) {
      console.error("sendMessage error:", error);
      socket.emit("error", { message: "Failed to send message" });
    }
  });

  // -------- Delete Message --------
  socket.on("deleteMessage", async ({ messageId }) => {
    try {
      const message = await Message.findById(messageId);
      
      if (!message) {
        return socket.emit("error", { message: "Message not found" });
      }
      
      if (message.sender.toString() !== socket.userId) {
        return socket.emit("error", { message: "Not authorized" });
      }

      const chatId = message.chatId;
      await message.deleteOne();

      // Update lastMessage if this was the last message
      const chat = await Chat.findById(chatId);
      if (chat.lastMessage?.toString() === messageId) {
        const lastMsg = await Message.findOne({ chatId })
          .sort({ createdAt: -1 });
        chat.lastMessage = lastMsg?._id || null;
        await chat.save();
      }

      // Emit to all chat participants
      io.to(chatId.toString()).emit("messageDeleted", { 
        messageId,
        chatId: chatId.toString()
      });
    } catch (error) {
      console.error("deleteMessage error:", error);
      socket.emit("error", { message: "Failed to delete message" });
    }
  });

  // -------- Typing Indicator --------
  socket.on("typing", ({ receiverId, chatId, isTyping }) => {
    if (receiverId) {
      io.to(receiverId).emit("userTyping", { 
        senderId: socket.userId,
        chatId,
        isTyping // true when typing, false when stopped
      });
    }
  });

  // -------- Stop Typing --------
  socket.on("stopTyping", ({ receiverId, chatId }) => {
    if (receiverId) {
      io.to(receiverId).emit("userTyping", { 
        senderId: socket.userId,
        chatId,
        isTyping: false
      });
    }
  });

  // -------- Seen Message --------
  socket.on("seenMessage", async ({ chatId }) => {
    try {
      if (!chatId) return;

      // Verify user is participant
      const chat = await Chat.findById(chatId);
      if (!chat || !chat.participants.includes(socket.userId)) {
        return;
      }

      // Update unseen messages
      const result = await Message.updateMany(
        { 
          chatId, 
          sender: { $ne: socket.userId },
          seenBy: { $ne: socket.userId } 
        },
        { $push: { seenBy: socket.userId } }
      );

      // Emit to all participants in chat
      if (result.modifiedCount > 0) {
        io.to(chatId.toString()).emit("messagesSeen", { 
          userId: socket.userId,
          chatId
        });
      }
    } catch (error) {
      console.error("seenMessage error:", error);
    }
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.userId}`);
  });
});
// ---------- Start Server ----------
server.listen(PORT, "0.0.0.0",  () => {
  console.log(`Server running on port ${PORT}`);
});
