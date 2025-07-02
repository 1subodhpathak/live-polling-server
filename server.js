const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const Poll = require('./models/Poll');
const User = require('./models/User');

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://vaarssp51:y7nkD5ddIFEIRgmJ@cluster0.nhc2lzv.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173", // Vite's default port
    methods: ["GET", "POST"]
  }
});

// Store active polls and connected users
let activePoll = null;
const connectedUsers = new Map();
let teacherSocket = null;

// Helper function to check if student name is unique
const isStudentNameUnique = async (name) => {
  // Check in-memory connected users
  for (let [socketId, user] of connectedUsers) {
    if (user.name === name && user.isStudent) {
      return false;
    }
  }
  
  // Check database for existing users
  const existingUser = await User.findOne({ name, role: 'student' });
  return !existingUser;
};

// Helper function to get all connected students
const getConnectedStudents = () => {
  const students = [];
  for (let [socketId, user] of connectedUsers) {
    if (user.isStudent) {
      students.push({ socketId, name: user.name, isOnline: true });
    }
  }
  // Optionally, you could also track offline students from the DB if needed
  return students;
};

// Helper function to check if all students have answered
const haveAllStudentsAnswered = () => {
  if (!activePoll) return true;
  
  const students = getConnectedStudents();
  const answeredStudents = new Set(activePoll.responses.map(r => r.studentName));
  
  return students.every(student => answeredStudents.has(student.name));
};

// Helper function to save poll to database
const savePollToDatabase = async (pollData) => {
  try {
    const poll = new Poll({
      ...pollData,
      totalStudents: getConnectedStudents().length
    });
    await poll.save();
    return poll._id;
  } catch (error) {
    console.error('Error saving poll:', error);
    return null;
  }
};

// Helper function to update poll in database
const updatePollInDatabase = async (pollId, updates) => {
  try {
    await Poll.findByIdAndUpdate(pollId, updates);
  } catch (error) {
    console.error('Error updating poll:', error);
  }
};

// Helper function to save user to database
const saveUserToDatabase = async (name, role, socketId) => {
  try {
    await User.findOneAndUpdate(
      { name, role },
      { socketId, isOnline: true, lastSeen: new Date() },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error('Error saving user:', error);
  }
};

// API Routes for past poll results
app.get('/api/polls', async (req, res) => {
  try {
    const polls = await Poll.find({ isActive: false })
      .sort({ createdAt: -1 })
      .limit(10);
    res.json(polls);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch polls' });
  }
});

app.get('/api/polls/:id', async (req, res) => {
  try {
    const poll = await Poll.findById(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }
    res.json(poll);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch poll' });
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle teacher connection
  socket.on('teacher-join', async () => {
    teacherSocket = socket;
    socket.join('teacher-room');
    console.log('Teacher joined');
    
    // Save teacher to database
    await saveUserToDatabase('Teacher', 'teacher', socket.id);
    
    // Send current state to teacher
    socket.emit('current-state', {
      activePoll,
      connectedStudents: getConnectedStudents(),
      canCreateNewPoll: !activePoll || haveAllStudentsAnswered()
    });
  });

  // Handle student connection
  socket.on('student-join', async (name) => {
    // Check if name is unique
    const isUnique = await isStudentNameUnique(name);
    if (!isUnique) {
      socket.emit('name-taken', { message: 'This name is already taken. Please choose a different name.' });
      return;
    }

    connectedUsers.set(socket.id, { name, isStudent: true });
    socket.join('student-room');
    console.log('Student joined:', name);
    
    // Save student to database
    await saveUserToDatabase(name, 'student', socket.id);
    
    // Confirm successful registration to student
    socket.emit('student-registered', { name });
    
    // Notify teacher about new student
    if (teacherSocket) {
      teacherSocket.emit('student-joined', { name, socketId: socket.id });
    }
    
    // Send current poll to new student if one is active
    if (activePoll) {
      socket.emit('new-poll', activePoll);
    }
  });

  // Handle new poll creation
  socket.on('create-poll', async (pollData) => {
    if (socket === teacherSocket) {
      // Check if we can create a new poll
      if (activePoll && !haveAllStudentsAnswered()) {
        socket.emit('poll-creation-failed', { 
          message: 'Cannot create new poll while current poll is still active' 
        });
        return;
      }

      // Save poll to database
      const pollId = await savePollToDatabase(pollData);
      
      activePoll = {
        _id: pollId,
        ...pollData,
        responses: [],
        startTime: Date.now(),
        timeLimit: pollData.timeLimit || 60 // Default 60 seconds
      };
      
      io.to('student-room').emit('new-poll', activePoll);
      console.log('New poll created:', activePoll.question);
    }
  });

  // Handle poll response
  socket.on('submit-answer', async (answer) => {
    if (activePoll && connectedUsers.has(socket.id)) {
      const student = connectedUsers.get(socket.id);
      
      // Check if student already answered
      const alreadyAnswered = activePoll.responses.some(r => r.studentName === student.name);
      if (alreadyAnswered) {
        socket.emit('already-answered', { message: 'You have already answered this poll' });
        return;
      }
      
      const response = {
        studentName: student.name,
        answer,
        timestamp: Date.now()
      };
      
      activePoll.responses.push(response);
      
      // Update poll in database
      if (activePoll._id) {
        await updatePollInDatabase(activePoll._id, {
          $push: { responses: response }
        });
      }
      
      // Broadcast updated results
      io.emit('poll-results', activePoll.responses);
      
      // Check if all students have answered
      if (haveAllStudentsAnswered()) {
        // Mark poll as completed in database
        if (activePoll._id) {
          await updatePollInDatabase(activePoll._id, {
            isActive: false,
            endTime: new Date()
          });
        }
        
        io.emit('poll-completed', { message: 'All students have answered the poll' });
        if (teacherSocket) {
          teacherSocket.emit('can-create-new-poll', { message: 'You can now create a new poll' });
        }
      }
    }
  });

  // Handle student kick-out
  socket.on('kick-student', async (studentSocketId) => {
    if (socket === teacherSocket && connectedUsers.has(studentSocketId)) {
      const student = connectedUsers.get(studentSocketId);
      
      // Update user status in database
      await User.findOneAndUpdate(
        { name: student.name, role: 'student' },
        { isOnline: false, lastSeen: new Date() }
      );
      
      io.to(studentSocketId).emit('kicked-out', { message: 'You have been removed by the teacher' });
      connectedUsers.delete(studentSocketId);
      io.sockets.sockets.get(studentSocketId)?.disconnect();
      console.log('Student kicked out:', student.name);
    }
  });

  // Handle chat messages
  socket.on('send-message', (messageData) => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      const message = {
        ...messageData,
        sender: user.name,
        isTeacher: !user.isStudent
      };
      
      // Broadcast message to all connected users
      io.emit('chat-message', message);
      console.log('Chat message:', message);
    }
  });

  // Handle get-participants request
  socket.on('get-participants', () => {
    const students = getConnectedStudents();
    socket.emit('participants-list', students);
  });

  // Handle rejoin-student request
  socket.on('rejoin-student', async (studentName) => {
    // Find the user in the DB and set isOnline to true
    await User.findOneAndUpdate(
      { name: studentName, role: 'student' },
      { isOnline: true, lastSeen: new Date() }
    );
    // Optionally, you could re-add to connectedUsers if you want to allow them to rejoin live
    // For now, just emit updated participants list
    if (teacherSocket) {
      teacherSocket.emit('participants-list', getConnectedStudents());
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    if (socket === teacherSocket) {
      teacherSocket = null;
    }
    
    const user = connectedUsers.get(socket.id);
    if (user) {
      // Update user status in database
      await User.findOneAndUpdate(
        { name: user.name, role: user.isStudent ? 'student' : 'teacher' },
        { isOnline: false, lastSeen: new Date() }
      );
    }
    
    connectedUsers.delete(socket.id);
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});