import express from "express";
import cors from "cors";
import "dotenv/config";
import http from "http";
import { Server } from "socket.io";
import job from "./lib/cron.js";
import { connectDB } from "./lib/db.js";
import { verifySocketToken } from "./middleware/socketAuth.js";
import NodeCache from "node-cache";

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

// ---------- Caching ----------
// Cache for 10 minutes, check every 2 minutes
const chatCache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); 
const userChatsCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min for user chats
const messageCache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // 10 min for messages

// ---------- Cache Helper Functions ----------
const getCacheKey = {
  chat: (userId, receiverId) => `chat:${[userId, receiverId].sort().join(":")}`,
  chatById: (chatId) => `chat:id:${chatId}`,
  userChats: (userId) => `userChats:${userId}`,
  message: (messageId) => `message:${messageId}`,
  chatMessages: (chatId) => `chatMessages:${chatId}`
};

const invalidateCache = {
  chat: (userId, receiverId) => {
    chatCache.del(getCacheKey.chat(userId, receiverId));
  },
  chatById: (chatId) => {
    chatCache.del(getCacheKey.chatById(chatId));
  },
  userChats: (userId) => {
    userChatsCache.del(getCacheKey.userChats(userId));
  },
  message: (messageId) => {
    messageCache.del(getCacheKey.message(messageId));
  },
  allUserChats: (participantIds) => {
    participantIds.forEach(userId => {
      userChatsCache.del(getCacheKey.userChats(userId));
    });
  },
  chatMessages: (chatId) => {
    messageCache.del(getCacheKey.chatMessages(chatId));
  }
};

// ---------- Socket Authentication ----------
io.use(verifySocketToken);

// ---------- Socket Events ----------
io.on("connection", async (socket) => {
  console.log(`User connected: ${socket.userId}`);
  
  // Join personal room
  socket.join(socket.userId);
  
  // Join all chat rooms user is part of
  try {
    const cacheKey = getCacheKey.userChats(socket.userId);
    let userChats = userChatsCache.get(cacheKey);
    
    if (!userChats) {
      userChats = await Chat.find({ participants: socket.userId });
      userChatsCache.set(cacheKey, userChats);
    }
    
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

      // Find or create chat with improved caching
      const chatKey = getCacheKey.chat(socket.userId, receiverId);
      let chat = chatCache.get(chatKey);
      
      if (!chat) {
        chat = await Chat.findOne({
          participants: { $all: [socket.userId, receiverId] },
        });
        
        if (!chat) {
          chat = await Chat.create({ participants: [socket.userId, receiverId] });
          // Invalidate sender's userChats cache
          invalidateCache.userChats(socket.userId);
          // Invalidate receiver's userChats cache
          invalidateCache.userChats(receiverId);
        }
        
        // Cache the chat after retrieval
        chatCache.set(chatKey, chat);
        chatCache.set(getCacheKey.chatById(chat._id), chat);
      }

      // Both users should join this new chat room
      socket.join(chat._id.toString());
      io.to(receiverId).socketsJoin(chat._id.toString());

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
      
      // Update cache with new chat data
      chatCache.set(chatKey, chat);
      chatCache.set(getCacheKey.chatById(chat._id), chat);
      // Invalidate chat messages cache
      invalidateCache.chatMessages(chat._id.toString());

      // Populate chat for frontend
      await chat.populate("participants", "username profileImage email");
      await chat.populate("lastMessage");

      // Emit to receiver
      io.to(receiverId).emit("receiveMessage", {
        message,
        chat,
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
      const messageCacheKey = getCacheKey.message(messageId);
      let message = messageCache.get(messageCacheKey);
      
      if (!message) {
        message = await Message.findById(messageId);
      }
      
      if (!message) {
        return socket.emit("error", { message: "Message not found" });
      }
      
      if (message.sender.toString() !== socket.userId) {
        return socket.emit("error", { message: "Not authorized" });
      }

      const chatId = message.chatId;
      await message.deleteOne();
      
      // Invalidate message cache
      invalidateCache.message(messageId);

      // Update lastMessage if this was the last message
      let chat = chatCache.get(getCacheKey.chatById(chatId));
      
      if (!chat) {
        chat = await Chat.findById(chatId);
      }
      
      if (chat?.lastMessage?.toString() === messageId) {
        const lastMsg = await Message.findOne({ chatId })
          .sort({ createdAt: -1 });
        chat.lastMessage = lastMsg?._id || null;
        await chat.save();
        
        // Update cache
        chatCache.set(getCacheKey.chatById(chatId), chat);
      }
      
      // Invalidate all related caches
      invalidateCache.chatMessages(chatId.toString());

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
        isTyping
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
      let chat = chatCache.get(getCacheKey.chatById(chatId));
      
      if (!chat) {
        chat = await Chat.findById(chatId);
        if (chat) {
          chatCache.set(getCacheKey.chatById(chatId), chat);
        }
      }
      
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

      // Invalidate message cache for this chat
      if (result.modifiedCount > 0) {
        invalidateCache.chatMessages(chatId.toString());
        
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
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
