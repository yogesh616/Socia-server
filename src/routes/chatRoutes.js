import express from "express";
import protectRoute from "../middleware/auth.middleware.js";
import Chat from "../models/Chat.js";
import Message from "../models/Message.js";

const router = express.Router();

// ---------- Get all chats for logged-in user ----------
router.get("/", protectRoute, async (req, res) => {
  try {
    const chats = await Chat.find({ participants: req.user._id })
      .populate("participants", "username profileImage email")
      .populate("lastMessage")
      .sort({ updatedAt: -1 });

    res.json(chats);
  } catch (err) {
    console.error("Get chats error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------- Get or create a chat with a user ----------
router.post("/start/:receiverId", protectRoute, async (req, res) => {
  try {
    const { receiverId } = req.params;

    let chat = await Chat.findOne({
      participants: { $all: [req.user._id, receiverId] },
    });

    if (!chat) {
      chat = await Chat.create({ participants: [req.user._id, receiverId] });
    }

    await chat.populate("participants", "username profileImage email");
    res.json(chat);
  } catch (err) {
    console.error("Start chat error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------- Get messages for a chat ----------
router.get("/:chatId/messages", protectRoute, async (req, res) => {
  try {
    const messages = await Message.find({ chatId: req.params.chatId })
      .populate("sender", "username profileImage")
      .sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------- Delete a message ----------
router.delete("/message/:messageId", protectRoute, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ message: "Message not found" });

    if (message.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await message.deleteOne();
    res.json({ message: "Message deleted" });
  } catch (err) {
    console.error("Delete message error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
