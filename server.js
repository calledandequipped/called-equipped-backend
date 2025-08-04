// server.js - Main backend server file
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: '*'
}));
// IMPORTANT: Raw body needed for Stripe webhooks BEFORE json parsing
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

// JSON parsing for all other routes
app.use(express.json());

// MongoDB connection
let db;
const mongoClient = new MongoClient(process.env.MONGODB_URI);

async function connectDB() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('calledandequipped');
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail', // Or use SendGrid, Mailgun, etc.
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS // Use app password for Gmail
  }
});

// Stripe price IDs (set these up in Stripe Dashboard)
const PRICE_IDS = {
  individual: process.env.STRIPE_PRICE_INDIVIDUAL, // $197
  coaching: process.env.STRIPE_PRICE_COACHING // $497
};

// Create Stripe checkout session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { plan, email } = req.body;

    if (!plan || !PRICE_IDS[plan]) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    // Create or update customer in database
    const customer = await db.collection('customers').findOneAndUpdate(
      { email },
      { 
        $set: { 
          email, 
          plan,
          createdAt: new Date(),
          status: 'pending'
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price: PRICE_IDS[plan],
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      customer_email: email,
      metadata: {
        customerId: customer._id.toString(),
        plan: plan
      }
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe webhook handler
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      await handleSuccessfulPayment(event.data.object);
      break;
    case 'payment_intent.payment_failed':
      await handleFailedPayment(event.data.object);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

// Handle successful payment
async function handleSuccessfulPayment(session) {
  console.log('=== WEBHOOK: Payment successful ===');
  console.log('Session ID:', session.id);
  console.log('Customer email:', session.customer_email);
  
  try {
    const { customerId, plan } = session.metadata;
    console.log('Customer ID from metadata:', customerId);
    console.log('Plan:', plan);
    
    // Update customer status
    const customer = await db.collection('customers').findOneAndUpdate(
      { _id: new ObjectId(customerId) },
      {
        $set: {
          status: 'active',
          stripeSessionId: session.id,
          stripeCustomerId: session.customer,
          paymentDate: new Date(),
          enrollmentDate: new Date(),
          currentWeek: 1,
          weekUnlockDates: generateWeekUnlockDates(),
          plan: plan
        }
      },
      { returnDocument: 'after' }
    );

    console.log('Customer updated in database:', customer.email);

    // Send welcome email
    await sendWelcomeEmail(customer);

    // Create access token for student portal
    const accessToken = generateAccessToken();
    await db.collection('customers').updateOne(
      { _id: new ObjectId(customerId) },
      { $set: { accessToken } }
    );
    
    console.log('Access token created for customer');

  } catch (error) {
    console.error('Error in handleSuccessfulPayment:', error);
  }
}

// Generate week unlock dates (every 7 days from enrollment)
function generateWeekUnlockDates() {
  const dates = [];
  const now = new Date();
  
  for (let i = 0; i < 6; i++) {
    const unlockDate = new Date(now);
    unlockDate.setDate(unlockDate.getDate() + (i * 7));
    dates.push({
      week: i + 1,
      unlockDate: unlockDate,
      isUnlocked: i === 0 // Only week 1 is immediately unlocked
    });
  }
  
  return dates;
}

// Generate unique access token
function generateAccessToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

// Send welcome email
async function sendWelcomeEmail(customer) {
  console.log('Attempting to send welcome email to:', customer.email);
  
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Georgia, serif; line-height: 1.6; color: #2C2C2C; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1B3A57; color: white; padding: 30px; text-align: center; }
        .header h1 { color: #D4AF37; margin: 0; }
        .content { background: #FBF7F0; padding: 30px; }
        .button { 
          display: inline-block; 
          padding: 15px 30px; 
          background: #D4AF37; 
          color: #1B3A57; 
          text-decoration: none; 
          border-radius: 5px;
          font-weight: bold;
          margin: 20px 0;
        }
        .footer { text-align: center; padding: 20px; color: #7C8471; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to Called & Equipped!</h1>
          <p>Your journey to discovering your divine purpose begins now</p>
        </div>
        
        <div class="content">
          <h2>Dear ${customer.email},</h2>
          
          <p>Congratulations on taking this transformative step! We're thrilled to have you join our 6-week masterclass.</p>
          
          <h3>Here's what happens next:</h3>
          <ul>
            <li><strong>Week 1 materials are now available!</strong> You can access them immediately.</li>
            <li>New content will unlock every 7 days automatically</li>
            <li>Join our private Facebook community for support and encouragement</li>
            <li>Download your Purpose Discovery Workbook from the student portal</li>
          </ul>
          
          <p style="text-align: center;">
            <a href="${process.env.FRONTEND_URL}/portal?token=${customer.accessToken}" class="button">
              Access Your Student Portal
            </a>
          </p>
          
          <h3>Your First Week: Created for a Purpose</h3>
          <p>This week, you'll explore:</p>
          <ul>
            <li>Monday: You Are God's Masterpiece (Ephesians 2:10)</li>
            <li>Wednesday: Before You Were Born (Jeremiah 1:5)</li>
            <li>Friday: The Joseph Journey (Genesis 37-50)</li>
          </ul>
          
          <p><strong>Important:</strong> Save this email! Your unique access link above is your key to the student portal.</p>
          
          <h3>Need Help?</h3>
          <p>If you have any questions or technical issues, please email us at support@calledandequipped.com</p>
          
          <p>We're praying for you as you begin this journey!</p>
          
          <p>Blessings,<br>
          The Called & Equipped Team</p>
        </div>
        
        <div class="footer">
          <p>Called & Equipped | Discovering Your Divine Purpose</p>
          <p>© 2024 All Rights Reserved</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    console.log('Email configuration:', {
      user: process.env.EMAIL_USER,
      passLength: process.env.EMAIL_PASS ? process.env.EMAIL_PASS.length : 0
    });
    
    await transporter.sendMail({
      from: `"Called & Equipped" <${process.env.EMAIL_USER}>`,
      to: customer.email,
      subject: 'Welcome to Called & Equipped - Your Access Details Inside',
      html: emailHtml
    });
    console.log('Welcome email sent successfully to:', customer.email);
  } catch (error) {
    console.error('Error sending welcome email - Full details:', error);
    console.error('Error code:', error.code);
    console.error('Error response:', error.response);
  }
}

// Weekly content unlock cron job (runs daily at 9 AM)
cron.schedule('0 9 * * *', async () => {
  console.log('Running weekly content unlock check...');
  
  try {
    const customers = await db.collection('customers').find({ 
      status: 'active' 
    }).toArray();

    for (const customer of customers) {
      const today = new Date();
      let weekUpdated = false;

      // Check each week's unlock date
      for (const weekData of customer.weekUnlockDates) {
        if (!weekData.isUnlocked && new Date(weekData.unlockDate) <= today) {
          // Unlock this week
          await db.collection('customers').updateOne(
            { 
              _id: customer._id,
              'weekUnlockDates.week': weekData.week 
            },
            { 
              $set: { 
                'weekUnlockDates.$.isUnlocked': true,
                currentWeek: weekData.week
              }
            }
          );

          // Send week unlock email
          await sendWeekUnlockEmail(customer, weekData.week);
          weekUpdated = true;
        }
      }
    }
  } catch (error) {
    console.error('Error in weekly unlock cron:', error);
  }
});

// Send week unlock email
async function sendWeekUnlockEmail(customer, weekNumber) {
  const weekContent = {
    2: {
      title: "Hearing God's Voice",
      sessions: [
        "Monday: The Many Ways God Speaks",
        "Wednesday: Cultivating a Listening Heart",
        "Friday: Confirming Your Calling"
      ]
    },
    3: {
      title: "Aligning Passion with Purpose",
      sessions: [
        "Monday: Holy Ambition",
        "Wednesday: Marketplace Ministry",
        "Friday: Stewardship of Talents"
      ]
    },
    4: {
      title: "Overcoming Purpose Blockers",
      sessions: [
        "Monday: Conquering Fear and Doubt",
        "Wednesday: Breaking Comparison and Competition",
        "Friday: Patience in the Process"
      ]
    },
    5: {
      title: "Practical Purpose Implementation",
      sessions: [
        "Monday: Strategic Planning with God",
        "Wednesday: Building Your Purpose Support System",
        "Friday: Financial Stewardship for Purpose"
      ]
    },
    6: {
      title: "Living Your Purpose Daily",
      sessions: [
        "Monday: Daily Rhythms of Purpose",
        "Wednesday: Legacy and Multiplication",
        "Friday: Commissioning and Sending"
      ]
    }
  };

  const week = weekContent[weekNumber];
  if (!week) return;

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Georgia, serif; line-height: 1.6; color: #2C2C2C; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #D4AF37; color: #1B3A57; padding: 30px; text-align: center; }
        .content { background: #FBF7F0; padding: 30px; }
        .button { 
          display: inline-block; 
          padding: 15px 30px; 
          background: #1B3A57; 
          color: white; 
          text-decoration: none; 
          border-radius: 5px;
          font-weight: bold;
          margin: 20px 0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Week ${weekNumber} is Now Available!</h1>
          <h2>${week.title}</h2>
        </div>
        
        <div class="content">
          <p>Congratulations on completing Week ${weekNumber - 1}! Your next week of content is now unlocked.</p>
          
          <h3>This Week's Journey:</h3>
          <ul>
            ${week.sessions.map(session => `<li>${session}</li>`).join('')}
          </ul>
          
          <p style="text-align: center;">
            <a href="${process.env.FRONTEND_URL}/portal?token=${customer.accessToken}" class="button">
              Access Week ${weekNumber} Content
            </a>
          </p>
          
          <p>Remember to download this week's reflection journal and join our community discussions!</p>
          
          <p>Keep pressing forward in your purpose journey!</p>
          
          <p>Blessings,<br>
          The Called & Equipped Team</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await transporter.sendMail({
      from: `"Called & Equipped" <${process.env.EMAIL_USER}>`,
      to: customer.email,
      subject: `Week ${weekNumber} Unlocked: ${week.title}`,
      html: emailHtml
    });
    console.log(`Week ${weekNumber} unlock email sent to:`, customer.email);
  } catch (error) {
    console.error('Error sending week unlock email:', error);
  }
}

// Verify student access
app.get('/api/verify-access', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(401).json({ error: 'No access token provided' });
    }

    const customer = await db.collection('customers').findOne({ 
      accessToken: token,
      status: 'active'
    });

    if (!customer) {
      return res.status(401).json({ error: 'Invalid or expired access token' });
    }

    // Return customer data without sensitive info
    const { email, plan, currentWeek, weekUnlockDates, enrollmentDate } = customer;
    res.json({
      email,
      plan,
      currentWeek,
      weekUnlockDates,
      enrollmentDate
    });

  } catch (error) {
    console.error('Access verification error:', error);
    res.status(500).json({ error: 'Failed to verify access' });
  }
});

// Get customer progress
app.get('/api/progress/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const customer = await db.collection('customers').findOne({ 
      accessToken: token,
      status: 'active'
    });

    if (!customer) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    // Calculate progress
    const completedWeeks = customer.weekUnlockDates.filter(w => w.isUnlocked).length - 1;
    const totalSessions = completedWeeks * 3;
    const progressPercentage = Math.round((completedWeeks / 6) * 100);

    res.json({
      currentWeek: customer.currentWeek,
      completedWeeks,
      totalSessions,
      progressPercentage,
      weekUnlockDates: customer.weekUnlockDates
    });

  } catch (error) {
    console.error('Progress fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// Handle failed payment
async function handleFailedPayment(paymentIntent) {
  console.log('Payment failed for:', paymentIntent.id);
  // Update customer status or send failure email
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Start server
async function startServer() {
  await connectDB();
  
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Webhook endpoint:', `${process.env.BACKEND_URL}/api/stripe-webhook`);
  });
}

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await mongoClient.close();
  process.exit(0);
});