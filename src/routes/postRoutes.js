import express from "express";
import cloudinary from "../lib/cloudinary.js";
import Post from "../models/Post.js";
import User from "../models/User.js";
import protectRoute from "../middleware/auth.middleware.js";

const router = express.Router();

// ------------------- CREATE POST -------------------
router.post("/", protectRoute, async (req, res) => {
  try {
    const { caption = "", image, video, location = "", tags = [] } = req.body;

    if (!image && !video)
      return res.status(400).json({ message: "Provide an image or video" });

    // upload in parallel
    const [imageUpload, videoUpload] = await Promise.all([
      image ? cloudinary.uploader.upload(image) : null,
      video
        ? cloudinary.uploader.upload(video, { resource_type: "video" })
        : null,
    ]);

    const newPost = new Post({
      caption,
      image: imageUpload?.secure_url || "",
      video: videoUpload?.secure_url || "",
      imageId: imageUpload?.public_id || "",
      videoId: videoUpload?.public_id || "",
      location,
      tags: Array.isArray(tags) ? tags.map((t) => t.trim()) : [],
      user: req.user._id,
    });

    await newPost.save();
    await newPost.populate("user", "username profileImage");

    res.status(201).json(newPost);
  } catch (err) {
    console.error("Error creating post:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ------------------- GET USER POSTS -------------------
router.get("/user/me", protectRoute, async (req, res) => {
  try {
    const posts = await Post.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .populate("user", "username profileImage");

    res.json(posts);
  } catch (err) {
    console.error("Get my posts error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/user/:userId", protectRoute, async (req, res) => {
  try {
    const posts = await Post.find({ user: req.params.userId })
      .sort({ createdAt: -1 })
      .populate("user", "username profileImage");

    res.json(posts);
  } catch (err) {
    console.error("Get user posts error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------- GET ALL POSTS -------------------
router.get("/", protectRoute, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const [posts, totalPosts] = await Promise.all([
      Post.find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("user", "username profileImage")
        .populate("comments.user", "username profileImage"),
      Post.countDocuments(),
    ]);

    res.json({
      posts,
      currentPage: page,
      totalPages: Math.ceil(totalPosts / limit),
      totalPosts,
    });
  } catch (err) {
    console.error("Error fetching posts:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ------------------- GET SINGLE POST -------------------
router.get("/:id", protectRoute, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate("user", "username profileImage")
      .populate("comments.user", "username profileImage");

    if (!post) return res.status(404).json({ message: "Post not found" });
    res.json(post);
  } catch (err) {
    console.error("Error getting post:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ------------------- LIKE / UNLIKE -------------------
router.post("/:id/like", protectRoute, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const userId = req.user._id.toString();
    const liked = post.likes?.some((id) => id.toString() === userId);

    post.likes = liked
      ? post.likes.filter((id) => id.toString() !== userId)
      : [...post.likes, req.user._id];

    await post.save();
    await post.populate("user", "username profileImage");

    res.json({
      message: liked ? "Post unliked" : "Post liked",
      likesCount: post.likes.length,
      isLiked: !liked,
    });
  } catch (err) {
    console.error("Error liking post:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ------------------- COMMENTS -------------------

router.post("/:id/comment", protectRoute, async (req, res) => {
  try {
    const text = req.body.text?.trim();
    if (!text) return res.status(400).json({ message: "Comment required" });
    if (text.length > 500)
      return res.status(400).json({ message: "Comment too long (max 500)" });

    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    post.comments.push({ user: req.user._id, text });
    await post.save();
    await post.populate("comments.user", "username profileImage");

    res.status(201).json({
      message: "Comment added",
      comment: post.comments[post.comments.length - 1],
      commentsCount: post.comments.length,
    });
  } catch (err) {
    console.error("Error adding comment:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:id/comments", protectRoute, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).populate(
      "comments.user",
      "username profileImage"
    );
    if (!post) return res.status(404).json({ message: "Post not found" });
    res.json({ comments: post.comments, commentsCount: post.comments.length });
  } catch (err) {
    console.error("Error getting comments:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.put("/:postId/comment/:commentId", protectRoute, async (req, res) => {
  try {
    const text = req.body.text?.trim();
    if (!text) return res.status(400).json({ message: "Comment required" });

    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    if (comment.user.toString() !== req.user._id.toString())
      return res.status(403).json({ message: "Not authorized" });

    comment.text = text;
    await post.save();
    await post.populate("comments.user", "username profileImage");

    res.json({ message: "Comment updated", comment });
  } catch (err) {
    console.error("Error updating comment:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.delete("/:postId/comment/:commentId", protectRoute, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    const isOwner =
      comment.user.toString() === req.user._id.toString() ||
      post.user.toString() === req.user._id.toString();

    if (!isOwner)
      return res.status(403).json({ message: "Not authorized to delete" });

    comment.deleteOne();
    await post.save();

    res.json({ message: "Comment deleted", commentsCount: post.comments.length });
  } catch (err) {
    console.error("Error deleting comment:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ------------------- UPDATE POST -------------------
router.put("/:id", protectRoute, async (req, res) => {
  try {
    const { caption, location, tags } = req.body;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (post.user.toString() !== req.user._id.toString())
      return res.status(403).json({ message: "Not authorized" });

    if (caption !== undefined) post.caption = caption;
    if (location !== undefined) post.location = location;
    if (tags !== undefined)
      post.tags = Array.isArray(tags) ? tags.map((t) => t.trim()) : [];

    await post.save();
    await post.populate("user", "username profileImage");
    res.json({ message: "Post updated", post });
  } catch (err) {
    console.error("Error updating post:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ------------------- PIN / UNPIN -------------------
router.patch("/:id/pin", protectRoute, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });
    if (post.user.toString() !== req.user._id.toString())
      return res.status(403).json({ message: "Not authorized" });

    post.isPinned = !post.isPinned;
    await post.save();
    res.json({
      message: post.isPinned ? "Post pinned" : "Post unpinned",
      isPinned: post.isPinned,
    });
  } catch (err) {
    console.error("Error toggling pin:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ------------------- DELETE POST -------------------
router.delete("/:id", protectRoute, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });
    if (post.user.toString() !== req.user._id.toString())
      return res.status(403).json({ message: "Not authorized" });

    // cleanup media
    const destroyOps = [];
    if (post.imageId) destroyOps.push(cloudinary.uploader.destroy(post.imageId));
    if (post.videoId)
      destroyOps.push(
        cloudinary.uploader.destroy(post.videoId, { resource_type: "video" })
      );
    await Promise.all(destroyOps);

    await post.deleteOne();
    await User.findByIdAndUpdate(post.user, { $pull: { posts: post._id } });

    res.json({ message: "Post deleted" });
  } catch (err) {
    console.error("Error deleting post:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
