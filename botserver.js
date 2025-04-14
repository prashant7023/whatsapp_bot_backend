require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');
const MessagingResponse = twilio.twiml.MessagingResponse;

// Initialize Express
const app = express();
const PORT = process.env.BOT_PORT || 3001;

// User state tracking for conversation context
const userStates = {};

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Server API base URL
const SERVER_URL = process.env.SERVER_URL || 'https://localhost:5001';

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cors());

// Initialize Twilio client
let twilioClient;
try {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  // Validate Twilio credentials
  if (!accountSid || !accountSid.startsWith('AC')) {
    throw new Error('Invalid Twilio Account SID. Must start with "AC".');
  }
  
  if (!authToken) {
    throw new Error('Twilio Auth Token is missing.');
  }
  
  // Log the first few characters of the account SID for debugging
  console.log(`Initializing Twilio client with SID: ${accountSid.substring(0, 5)}...`);
  
  twilioClient = twilio(accountSid, authToken);
  console.log('Twilio client initialized successfully');
} catch (error) {
  console.error('Error initializing Twilio client:', error.message);
  console.warn('WhatsApp messaging functionality will be disabled.');
  twilioClient = null;
}

// Print our webhook URL for easier configuration
console.log('=================================================');
console.log(`WebHook URL for Twilio: ${process.env.NGROK_URL}/api/webhook`);
console.log('=================================================');

// Configure controllers for medicine and product searches
let searchMedicinesAPI;
let searchProductsAPI;

// Try to import the controllers directly for better performance
try {
  const medicineController = require('../server/controllers/fetch-medicines');
  const productController = require('../server/controllers/fetch-products');
  
  console.log('Successfully imported controller modules');
  // Set the API functions to use the controller methods directly
  searchMedicinesAPI = medicineController.searchMedicines;
  searchProductsAPI = productController.searchProducts;
  
  console.log('Enhanced search functionality enabled via direct controller imports');
} catch (importError) {
  console.error('Error importing controller modules:', importError.message);
  console.log('Will fall back to API-based search');
  
  // Define fallback functions that use the API
  searchMedicinesAPI = async (query, limit = 100) => {
    try {
      console.log(`[API Fallback] Searching for medicines with query: "${query}"`);
      // Sanitize query to prevent issues
      const sanitizedQuery = query.trim();
      
      if (!sanitizedQuery) {
        console.log('[API Fallback] Empty query, returning empty results');
        return { medicines: [], count: 0 };
      }
      
      const response = await axios.get(`${SERVER_URL}/api/medicines/search`, {
        params: { query: sanitizedQuery, limit }
      });
      
      if (response.data && response.data.medicines) {
        console.log(`[API Fallback] Found ${response.data.medicines.length} medicines via API`);
        return response.data;  // Return the whole response object with medicines property
      } else {
        console.log('[API Fallback] Received unexpected response format from medicines API:', response.data);
        return { medicines: [], count: 0 };
      }
    } catch (error) {
      console.error('[API Fallback] Error searching medicines via API:', error.message);
      // Return empty results instead of throwing to avoid breaking the search flow
      return { medicines: [], count: 0, error: error.message };
    }
  };
  
  searchProductsAPI = async (query, limit = 100) => {
    try {
      console.log(`[API Fallback] Searching for products with query: "${query}"`);
      // Sanitize query to prevent issues
      const sanitizedQuery = query.trim();
      
      if (!sanitizedQuery) {
        console.log('[API Fallback] Empty query, returning empty results');
        return { products: [], count: 0 };
      }
      
      const response = await axios.get(`${SERVER_URL}/api/products/search`, {
        params: { query: sanitizedQuery, limit }
      });
      
      if (response.data && response.data.products) {
        console.log(`[API Fallback] Found ${response.data.products.length} products via API`);
        return response.data;  // Return the whole response object with products property
      } else {
        console.log('[API Fallback] Received unexpected response format from products API:', response.data);
        return { products: [], count: 0 };
      }
    } catch (error) {
      console.error('[API Fallback] Error searching products via API:', error.message);
      // Return empty results instead of throwing to avoid breaking the search flow
      return { products: [], count: 0, error: error.message };
    }
  };
}

// Helper function to send WhatsApp messages
async function sendWhatsAppMessage(to, body) {
  try {
    // Check if Twilio client is available
    if (!twilioClient) {
      console.warn('Cannot send WhatsApp message: Twilio client is not initialized');
      return false;
    }
    
    // Add whatsapp: prefix to both the from and to numbers
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const formattedFrom = `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`;
    
    await twilioClient.messages.create({
      from: formattedFrom,
      to: formattedTo,
      body: body
    });
    console.log(`Message sent to ${to}`);
    return true;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    return false;
  }
}

// Route to handle incoming WhatsApp messages
app.post('/api/webhook', async (req, res) => {
  const twiml = new MessagingResponse();
  const fromNumber = req.body.From || '';
  const message = req.body.Body ? req.body.Body.trim() : '';
  
  console.log(`Received message from ${fromNumber}: ${message}`);
  console.log('Request body:', JSON.stringify(req.body));

  try {
    // Handle media messages (images, documents)
    if (req.body.NumMedia && parseInt(req.body.NumMedia) > 0) {
      try {
        const numMedia = parseInt(req.body.NumMedia);
        console.log(`Received media message with ${numMedia} attachments`);
        
        let mediaUrls = [];
        let mediaTypes = [];
        
        // Collect all media URLs and types
        for (let i = 0; i < numMedia; i++) {
          const mediaUrl = req.body[`MediaUrl${i}`];
          const contentType = req.body[`MediaContentType${i}`];
          mediaUrls.push(mediaUrl);
          mediaTypes.push(contentType);
          console.log(`Media ${i}: ${mediaUrl} (${contentType})`);
        }
        
        const messageBody = req.body.Body ? req.body.Body.trim() : '';
        
        // Check if this is likely a prescription upload
        const isPrescription = messageBody.toLowerCase().includes('prescription') || 
                             messageBody.toLowerCase().includes('medicine') ||
                             mediaTypes.some(type => type.includes('image') || type.includes('pdf'));
        
        if (isPrescription) {
          // Process as prescription upload - just use the first media for now
          const response = await handlePrescriptionUpload(fromNumber, mediaUrls[0], messageBody);
          twiml.message(response);
          res.writeHead(200, {'Content-Type': 'text/xml'});
          return res.end(twiml.toString());
        } else {
          // Generic response for other media
          twiml.message(`Thank you for sending media. If this is a prescription, please resend with the caption "prescription" or reply with "upload prescription" for instructions.`);
          res.writeHead(200, {'Content-Type': 'text/xml'});
          return res.end(twiml.toString());
        }
      } catch (mediaError) {
        console.error('Error handling media message:', mediaError);
        twiml.message('Sorry, we had trouble processing your media. Please try again.');
      }
    } else {
      // Process text messages
      console.log(`Processing message: "${message}"`);
      let response = '';
      
      try {
        // Use our main message processing function
        response = await processMessage(message, fromNumber);
      } catch (error) {
        console.error('Error processing message:', error);
        response = "Sorry, I encountered an error. Please try again or type 'menu' to see options.";
      }
      
      console.log(`Response generated: "${response}"`);
      twiml.message(response);
    }
  } catch (error) {
    console.error('Webhook error:', error);
    twiml.message('Sorry, something went wrong. Please try again.');
  }

  console.log('TwiML response:', twiml.toString());
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

// Add another webhook route without the /api prefix
// This allows both /api/webhook and /webhook to work
app.post('/webhook', async (req, res) => {
  // Just forward to the main webhook handler
  app.handle(req, res, req.url = '/api/webhook');
});

// Helper function to check if a user exists by phone number and get their details
async function getUserDetailsByPhone(phoneNumber) {
  try {
    // Clean the phone number - remove any WhatsApp prefix and ensure it's in the correct format
    // The WhatsApp format is typically "whatsapp:+1234567890"
    let cleanedPhone = phoneNumber.replace('whatsapp:', '');
    
    // If the phone has a country code like +91, remove it as the database stores without it
    if (cleanedPhone.startsWith('+91')) {
      cleanedPhone = cleanedPhone.substring(3);
    }
    
    console.log(`[User Lookup] Checking for user with phone: ${cleanedPhone}`);
    
    // Query the users table to find a matching user
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("phone", cleanedPhone)
      .single();
      
    if (userError) {
      console.error(`[User Lookup] Error searching for user: ${userError.message}`);
      return { exists: false, error: userError.message };
    }
    
    if (!userData) {
      console.log(`[User Lookup] No user found with phone: ${cleanedPhone}`);
      return { exists: false };
    }
    
    console.log(`[User Lookup] Found user: ${userData.id}, username: ${userData.username}`);
    
    // First check the table structure to see what columns actually exist
    console.log(`[User Lookup] Checking orders table structure...`);
    try {
      // Get all orders for this user (without specifying columns that might not exist)
      const { data: orders, error: ordersError } = await supabase
        .from("orders")
        .select('*')
        .eq("user_id", userData.id)
        .order("created_at", { ascending: false })
        .limit(5);

      if (ordersError) {
        console.error(`[User Lookup] Error fetching orders: ${ordersError.message}`);
        return { 
          exists: true, 
          user: userData,
          orders: [],
          error: `Found user but couldn't fetch orders: ${ordersError.message}`
        };
      }

      console.log(`[User Lookup] Successfully fetched ${orders?.length || 0} orders`);
      
      // Process the orders we found
      let processedOrders = [];
      if (orders && orders.length > 0) {
        processedOrders = orders.map(order => {
          // Process items if they're stored as a string
          let processedItems = [];
          try {
            if (typeof order.items === 'string') {
              processedItems = JSON.parse(order.items);
            } else if (Array.isArray(order.items)) {
              processedItems = order.items;
            }
          } catch (e) {
            console.error(`[User Lookup] Error parsing order items: ${e.message}`);
          }
          
          // Return a processed order with only fields that exist
          return {
            id: order.id,
            status: order.status || 'Processing',
            total_amount: order.total_amount || order.total_price || 0,
            created_at: order.created_at,
            updated_at: order.updated_at,
            items: processedItems,
            // Only include these fields if they exist in the order object
            ...(order.payment_method && { payment_method: order.payment_method }),
            ...(order.payment_status && { payment_status: order.payment_status }),
            ...(order.delivery_info && { 
              delivery_info: typeof order.delivery_info === 'string' 
                ? JSON.parse(order.delivery_info) 
                : order.delivery_info 
            }),
            ...(order.shipping_address && { 
              shipping_address: typeof order.shipping_address === 'string' 
                ? JSON.parse(order.shipping_address) 
                : order.shipping_address 
            })
          };
        });
      }
      
      return {
        exists: true,
        user: userData,
        orders: processedOrders
      };
    } catch (error) {
      console.error(`[User Lookup] Error processing orders: ${error.message}`);
      return { 
        exists: true, 
        user: userData,
        orders: [],
        error: `Error processing orders: ${error.message}`
      };
    }
  } catch (error) {
    console.error(`[User Lookup] Unexpected error: ${error.message}`);
    return { exists: false, error: error.message };
  }
}

// Update the processMessage function to recognize and handle the user's order history
async function processMessage(message, phoneNumber) {
  try {
    console.log(`Processing message from ${phoneNumber}: "${message}"`);
    
    // Handle empty or null messages
    if (!message || message.trim() === '') {
      return getWelcomeMessage();
    }

    const lowerMessage = message.toLowerCase().trim();
    
    // First check for greetings and show menu
    if (['hi', 'hey', 'hello', 'hola', 'hy', 'start', 'menu', 'help'].includes(lowerMessage)) {
      console.log(`Greeting detected: "${lowerMessage}", showing menu`);
      return getWelcomeMessage();
    }
    
    // Check if it's a numeric option (1-6)
    if (/^[1-6]$/.test(lowerMessage)) {
      const option = parseInt(lowerMessage);
      console.log(`User ${phoneNumber} selected option ${option}`);
      
      if (option === 1) {
        return 'What medicine or product are you looking for? Please type the name.';
      }
      
      if (option === 2) {
        return 'Please provide your order ID to track.\n\nYou can enter it with or without the # prefix, for example: #A12C1234 or #65c53a12-4c6d-4569-a756-7a16a902c2e5';
      }
      
      if (option === 3) {
        console.log(`Fetching recent orders for ${phoneNumber}`);
        return await fetchRecentOrders(phoneNumber);
      }
      
      return handleMenuOption(option);
    }
    
    // Check for "track order" related commands
    if (lowerMessage === 'track' || lowerMessage.includes('track order')) {
      return 'Please provide your order ID to track.\n\nYou can enter it with or without the # prefix, for example: #A12C1234 or #65c53a12-4c6d-4569-a756-7a16a902c2e5';
    }
    
    // Check for recent orders related commands
    if (lowerMessage === 'recent' || lowerMessage === 'recent orders' || lowerMessage.includes('my order')) {
      console.log(`Recent orders command detected: "${lowerMessage}"`);
      return await fetchRecentOrders(phoneNumber);
    }
    
    // Check for order ID patterns:
    
    // 1. Check for UUID pattern: #65c53a12-4c6d-4569-a756-7a16a902c2e5 or ef3ac19a-5fa7-4ce2-a878-e3eb6dfb3066
    const fullUuidRegex = /^#?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
    if (fullUuidRegex.test(message.trim())) {
      console.log(`Full UUID pattern detected: "${message}"`);
      return await trackOrder(message, phoneNumber);
    }
    
    // 2. Check for short alphanumeric ID: #A12C1234 or A12C1234
    const shortIdRegex = /^#?([A-Za-z0-9]{6,12})$/;
    if (shortIdRegex.test(message.trim())) {
      console.log(`Short ID pattern detected: "${message}"`);
      return await trackOrder(message, phoneNumber);
    }
    
    // Check for search medicines command
    if (lowerMessage === 'search' || lowerMessage === 'medicines' || lowerMessage === 'medicine' || lowerMessage === 'products') {
      return 'What medicine or product are you looking for? Please type the name.';
    }
    
    // By default, treat as a medicine search
    console.log(`No specific context, treating as medicine search: "${message}"`);
    return await searchMedicines(message);
  } catch (error) {
    console.error("Error processing message:", error);
    return "Sorry, I encountered an error. Please try again or type 'menu' to see options.";
  }
}

// Helper function to handle menu options
function handleMenuOption(option) {
  switch(option) {
    case 1:
      return 'What medicine or product are you looking for? Please type the name.';
    case 2:
      return 'Please provide your order ID to track.\n\nYou can enter it with or without the # prefix, for example: #A12C1234 or A12C1234';
    case 3:
      return 'Fetching your recent orders...';
    case 4:
      return 'For prescription medicines, please upload your prescription through our website or app. ' +
             'A pharmacist will review it and help you place an order.\n\n' +
             'Visit our website at: https://medihut.com/prescriptions';
    case 5:
      return 'Our customer support team is available Monday to Saturday from 9am to 8pm.\n\n' +
             'You can call us at: +91 1234567890\n' +
             'Or email at: support@medihut.com\n\n' +
             'A support agent will contact you shortly.';
    case 6:
      return 'I\'ll check if you have an account with us using your WhatsApp number. One moment please...';
    default:
      return getWelcomeMessage();
  }
}

// Helper function to generate welcome message
function getWelcomeMessage() {
  return 'Welcome to MediHut! How can I help you today?\n\n' +
         '1️⃣ Search Medicines & Products\n' +
         '2️⃣ Track your order\n' +
         '3️⃣ View your recent orders\n' +
         '4️⃣ Get prescription help\n' +
         '5️⃣ Talk to customer support\n' +
         '6️⃣ My Account Info\n\n' +
         'Reply with a number (1-6) or type your request.';
}

// Search function that combines medicine and product search
async function searchMedicines(query) {
  try {
    console.log(`[Search] Searching for: "${query}"`);
    
    // Skip the order ID check for medicine searches
    // We only treat inputs with # prefix as order IDs now
    
    // Define a threshold for minimum query length
    if (!query || query.trim().length < 2) {
      return "Please provide a more specific medicine or product name to search for (at least 2 characters).";
    }
    
    // Clean up the query
    const cleanedQuery = query.trim();
    
    // Make the API request to the medicines endpoint
    console.log(`[Search] Making API request to ${SERVER_URL}/api/medicines/search?query=${encodeURIComponent(cleanedQuery)}`);
    
    const response = await axios.get(`${SERVER_URL}/api/medicines/search`, {
      params: { query: cleanedQuery }
    });
    
    const { medicines, count } = response.data;
    
    // Log the response for debugging
    console.log(`[Search] API response received. Found ${count} medicines.`);
    
    if (!medicines || medicines.length === 0) {
      return `No medicines found for "${cleanedQuery}". Please try a different search term.`;
    }
    
    // Format the response
    let result = `Search Results for "${cleanedQuery}":\n\n`;
    
    // Display up to 5 results
    const displayLimit = Math.min(5, medicines.length);
    
    for (let i = 0; i < displayLimit; i++) {
      const medicine = medicines[i];
      const name = medicine["Product Name"] || medicine.name || "Unknown";
      const manufacturer = medicine["Brand Name"] || medicine.manufacturer || "Unknown";
      const mrp = medicine.MRP || medicine.price || "N/A";
      
      result += `${i + 1}. ${name} (Medicine)\n`;
      result += `💊 By: ${manufacturer}\n`;
      result += `💰 Price: ₹${mrp}\n`;
      
      // Add prescription info if available
      if (medicine.prescription_required) {
        result += `⚠️ Requires prescription\n`;
      }
      
      if (i < displayLimit - 1) {
        result += `\n`;
      }
    }
    
    if (count > displayLimit) {
      result += `\nFound ${count} results. Showing top ${displayLimit} only.\n\n`;
    }
    
    result += `To place an order, please visit our website: https://medihut.com or reply with "menu" to return to the main menu.`;
    
    return result;
  } catch (error) {
    console.error("[Search] Error searching medicines:", error);
    return "Sorry, I couldn't complete your search right now. Please try again later.";
  }
}

// Function to track an order
async function trackOrder(orderIdInput, phoneNumber) {
  try {
    console.log(`[Tracking] Raw input: "${orderIdInput}"`);
    
    // Clean up the input - remove spaces and extract ID with or without # prefix
    let cleanedInput = orderIdInput.replace(/\s+/g, '');
    if (cleanedInput.startsWith('#')) {
      cleanedInput = cleanedInput.substring(1); // Remove # prefix
    }
    
    // Store both the original ID (could be full UUID) and first part (partial UUID)
    let originalId = cleanedInput;
    let partialId = cleanedInput;
    
    // If this is a UUID with dashes, extract the first part (before first dash)
    if (cleanedInput.includes('-')) {
      partialId = cleanedInput.split('-')[0];
      console.log(`[Tracking] Full UUID detected, using first part: ${partialId}`);
    } else {
      // This is already a partial ID - use as is, but keep it for different query attempts
      console.log(`[Tracking] Using order ID: ${partialId}`);
    }

    // Format phone number by removing whatsapp: prefix if present
    const formattedPhone = phoneNumber.replace('whatsapp:', '');
    console.log(`[Tracking] Tracking order for phone: ${formattedPhone}`);
    
    try {
      // First try with the partial ID
      console.log(`[Tracking] Attempting to find order with partial ID: ${partialId}`);
      let response;
      
      try {
        // Try with the partial ID first (most common case)
        response = await axios.get(`${SERVER_URL}/orders/${partialId}/track`, {
          params: { phone: formattedPhone }
        });
        
        if (response.data && response.data.order) {
          console.log(`[Tracking] Found order using partial ID: ${partialId}`);
        }
      } catch (partialError) {
        console.log(`[Tracking] Error tracking with partial ID: ${partialError.message}`);
        
        // If partial ID fails and we have a full UUID, try with the full ID
        if (originalId !== partialId) {
          console.log(`[Tracking] Attempting to find order with full UUID: ${originalId}`);
          try {
            response = await axios.get(`${SERVER_URL}/orders/${originalId}/track`, {
              params: { phone: formattedPhone }
            });
            
            if (response.data && response.data.order) {
              console.log(`[Tracking] Found order using full UUID: ${originalId}`);
            }
          } catch (fullError) {
            console.error(`[Tracking] Error tracking with full UUID: ${fullError.message}`);
            throw fullError; // Rethrow to be caught by outer catch
          }
        } else {
          throw partialError; // Rethrow if we only had a partial ID to try
        }
      }
      
      // If we got a response with an order
      if (response && response.data && response.data.order) {
        const order = response.data.order;
        console.log(`[Tracking] Found order: ${order.id || order.order_id}`);

        // Format the response
        let formattedResponse = `🧾 *Order #${partialId} Details*\n\n`;
        formattedResponse += `*Status:* ${order.status || 'Processing'}\n`;
        if (order.created_at) {
          formattedResponse += `*Date:* ${new Date(order.created_at).toLocaleDateString()}\n`;
        }
        
        // Include order items if available
        if (order.items) {
          let items = order.items;
          
          // Parse if it's a string
          if (typeof items === 'string') {
            try {
              items = JSON.parse(items);
            } catch (e) {
              console.error(`[Tracking] Error parsing order items: ${e.message}`);
              items = [];
            }
          }
          
          let totalItemsPrice = 0;
          
          if (Array.isArray(items) && items.length > 0) {
            formattedResponse += `\n*Order Items:*\n`;
            items.forEach(item => {
              // Extract name safely
              let itemName = 'Medicine';
              if (item.name) {
                itemName = item.name;
              } else if (item.medicine_name) {
                itemName = item.medicine_name;
              } else if (item.product_name) {
                itemName = item.product_name;
              }
              
              const quantity = item.quantity || 1;
              const price = item.price || 0;
              totalItemsPrice += (price * quantity);
              
              formattedResponse += `• ${quantity}x ${itemName} - ₹${price * quantity}\n`;
            });
          }
        }
        
        // Include payment details
        const totalAmount = order.total_price || order.total_amount || 0;
        formattedResponse += `\n*Payment Details:*\n`;
        formattedResponse += `*Total:* ₹${totalAmount}\n`;
        
        return formattedResponse;
      }
      
      // If we got here, no order was found
      return `We couldn't find order #${partialId}. Please check the order number and try again.`;
    } catch (error) {
      console.error(`[Tracking] Error tracking order: ${error.message}`);
      return `Sorry, I encountered an error while tracking your order. Please try again later or contact our customer support for assistance.`;
    }
  } catch (error) {
    console.error('[Tracking] Error in trackOrder function:', error);
    return 'Sorry, I encountered an error while tracking your order. Please try again later or contact our customer support for assistance.';
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'WhatsApp bot server is running' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('MediHut WhatsApp Bot Server is running. Send messages to our WhatsApp number to interact!');
});

// Function to send WhatsApp interactive buttons
async function sendWhatsAppButtons(to) {
  // For Twilio sandbox accounts, just use the text-based menu
  // We'll use a simple numbered list that works in all WhatsApp accounts
  try {
    if (!twilioClient) {
      console.warn('Cannot send WhatsApp buttons: Twilio client is not initialized');
      return false;
    }
    
    // Format the destination number
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    
    // Get the sandbox number if available
    // The "to" number in the webhook request actually contains the number the client messaged
    const sandboxNumber = process.env.TWILIO_SANDBOX_NUMBER || process.env.TWILIO_PHONE_NUMBER || '+14155238886';
    
    console.log(`[Menu] Sending menu using phone number: whatsapp:${sandboxNumber}`);
    
    // Send a message with a numbered list for Sandbox accounts
    try {
      await twilioClient.messages.create({
        from: `whatsapp:${sandboxNumber}`,
        to: formattedTo,
        body: "Please choose by sending the number:\n\n" +
              "1️⃣ Search Medicines & Products\n" +
              "2️⃣ Track Order\n" +
              "3️⃣ Recent Orders\n" + 
              "4️⃣ Prescription Help\n" +
              "5️⃣ Customer Support\n" +
              "6️⃣ My Account Info"
      });
      
      console.log(`Menu sent to ${to}`);
      return true;
    } catch (error) {
      console.error('Error sending menu message:', error);
      return false;
    }
  } catch (error) {
    console.error('Error in sendWhatsAppButtons:', error);
    return false;
  }
}

// Test connectivity to main server when the bot starts
async function testApiConnectivity() {
  let medicinesEndpointWorking = false;
  let productsEndpointWorking = false;
  
  try {
    console.log(`Testing connectivity to server at ${SERVER_URL}...`);
    
    // Test medicines endpoint
    try {
      console.log(`Testing medicines search endpoint...`);
      // Try using the direct controller first
      if (typeof searchMedicinesAPI === 'function') {
        const testQuery = 'paracetamol';
        const medicineResponse = await searchMedicinesAPI(testQuery, 5);
        
        if (Array.isArray(medicineResponse)) {
          console.log(`✅ Successfully connected to medicines API via controller! Found ${medicineResponse.length} medicines.`);
          medicinesEndpointWorking = true;
        } else if (medicineResponse && medicineResponse.medicines) {
          console.log(`✅ Successfully connected to medicines API! Found ${medicineResponse.medicines.length} medicines.`);
          medicinesEndpointWorking = true;
        } else {
          console.log('❌ Connected to medicines API but received unexpected response format:', medicineResponse);
        }
      } else {
        console.log('⚠️ searchMedicinesAPI is not a function, falling back to direct API test');
        const medicineResponse = await axios.get(`${SERVER_URL}/api/medicines/search`, {
          params: { query: 'paracetamol', limit: 5 }
        });
        
        if (medicineResponse.data && medicineResponse.data.medicines) {
          console.log(`✅ Successfully connected to medicines API! Found ${medicineResponse.data.medicines.length} medicines.`);
          medicinesEndpointWorking = true;
        } else {
          console.log('❌ Connected to medicines API but received unexpected response format:', medicineResponse.data);
        }
      }
    } catch (medicineError) {
      console.error('❌ Failed to connect to medicines API:', medicineError.message);
    }
    
    // Test products endpoint
    try {
      console.log(`Testing products search endpoint...`);
      // Try using the direct controller first
      if (typeof searchProductsAPI === 'function') {
        const testQuery = 'cream';
        const productResponse = await searchProductsAPI(testQuery, 5);
        
        if (Array.isArray(productResponse)) {
          console.log(`✅ Successfully connected to products API via controller! Found ${productResponse.length} products.`);
          productsEndpointWorking = true;
        } else if (productResponse && productResponse.products) {
          console.log(`✅ Successfully connected to products API! Found ${productResponse.products.length} products.`);
          productsEndpointWorking = true;
        } else {
          console.log('❌ Connected to products API but received unexpected response format:', productResponse);
        }
      } else {
        console.log('⚠️ searchProductsAPI is not a function, falling back to direct API test');
        const productResponse = await axios.get(`${SERVER_URL}/api/products/search`, {
          params: { query: 'cream', limit: 5 }
        });
        
        if (productResponse.data && productResponse.data.products) {
          console.log(`✅ Successfully connected to products API! Found ${productResponse.data.products.length} products.`);
          productsEndpointWorking = true;
        } else {
          console.log('❌ Connected to products API but received unexpected response format:', productResponse.data);
        }
      }
    } catch (productError) {
      console.error('❌ Failed to connect to products API:', productError.message);
    }
    
    // Overall status
    if (medicinesEndpointWorking && productsEndpointWorking) {
      console.log('✅ All API endpoints are working correctly!');
      return true;
    } else if (!medicinesEndpointWorking && !productsEndpointWorking) {
      console.log('❌ Both API endpoints failed. Please check server connections and configuration.');
      return false;
    } else {
      console.log('⚠️ Some API endpoints are working, but not all. Search functionality may be limited.');
      return true;
    }
  } catch (error) {
    console.error('❌ General error testing API connectivity:', error.message);
    console.error('Error details:', error.response ? error.response.data : 'No response data');
    console.log('Please make sure the main server is running and the SERVER_URL is correct.');
    return false;
  }
}

// Function to get recent orders for a user
async function fetchRecentOrders(phoneNumber) {
  try {
    console.log(`[Orders] Fetching recent orders for phone: ${phoneNumber}`);
    
    // Format phone number - strip WhatsApp prefix and country code
    let formattedPhone = phoneNumber.replace('whatsapp:', '');
    
    // Remove country code if present (keep only the 10 digits)
    if (formattedPhone.startsWith('+91')) {
      formattedPhone = formattedPhone.substring(3);
    }
    
    // Ensure we only have the 10-digit number
    if (formattedPhone.length > 10) {
      formattedPhone = formattedPhone.substring(formattedPhone.length - 10);
    }
    
    console.log(`[Orders] Using formatted phone: ${formattedPhone}`);
    
    try {
      // Make API request with clear error handling
      console.log(`[Orders] Making API request to: ${SERVER_URL}/orders/history-by-phone?phone=${formattedPhone}`);
      
      const response = await axios.get(`${SERVER_URL}/orders/history-by-phone?phone=${formattedPhone}`, {
        timeout: 8000 // Set a reasonable timeout
      });
      
      // Check if we have any orders
      if (!response.data || !response.data.orders || response.data.orders.length === 0) {
        console.log('[Orders] No orders found for this user');
        return "You don't have any recent orders. To place an order, please visit our website at https://medihut.com";
      }
      
      const orders = response.data.orders;
      console.log(`[Orders] Found ${orders.length} orders for user`);
      
      // Format the response with order details
      let formattedResponse = `📋 *Your Recent Orders*\n\n`;
      
      // Show up to 3 orders
      orders.slice(0, 3).forEach((order, index) => {
        // Format the date
        const orderDate = order.created_at ? new Date(order.created_at).toLocaleDateString() : 'Unknown date';
        
        formattedResponse += `🧾 *Order #${order.id || order.order_id}*\n`;
        formattedResponse += `📅 Date: ${orderDate}\n`;
        formattedResponse += `📦 Status: ${order.status || 'Processing'}\n`;
        
        // Include items if available
        if (order.items && Array.isArray(order.items) && order.items.length > 0) {
          formattedResponse += `\n*Items:*\n`;
          
          // Show up to 5 items
          order.items.slice(0, 5).forEach(item => {
            const itemName = item.name || 'Unknown Product';
            const quantity = item.quantity || 1;
            const price = item.price || 0;
            
            formattedResponse += `• ${quantity}x ${itemName} - ₹${(price * quantity).toFixed(2)}\n`;
          });
          
          // Show count of additional items
          if (order.items.length > 5) {
            formattedResponse += `• ...and ${order.items.length - 5} more items\n`;
          }
        }
        
        // Show total amount
        const totalAmount = order.total_price || order.total_amount || 0;
        formattedResponse += `\n💰 *Total:* ₹${totalAmount}\n`;
        
        // Add tracking info
        formattedResponse += `\nTo track this order, send: *#${order.id || order.order_id}*\n`;
        
        // Add separator between orders
        if (index < Math.min(orders.length, 3) - 1) {
          formattedResponse += `\n${'─'.repeat(20)}\n\n`;
        }
      });
      
      return formattedResponse;
      
    } catch (error) {
      console.error(`[Orders] API error: ${error.message}`);
      
      // Try alternative method - get user details first
      try {
        console.log(`[Orders] Trying alternative method to get user orders...`);
        
        // Get user details from database
        const { data: userData, error: userError } = await supabase
          .from("users")
          .select("id, phone, username")
          .eq("phone", formattedPhone)
          .single();
          
        if (userError || !userData) {
          console.error(`[Orders] No user found: ${userError?.message || 'User not found'}`);
          return "No orders found for your number. To place an order, please visit our website at https://medihut.com";
        }
        
        console.log(`[Orders] Found user: ${userData.username || userData.id}`);
        
        // Now get their orders
        const { data: orders, error: ordersError } = await supabase
          .from("orders")
          .select("*")
          .eq("user_id", userData.id)
          .order("created_at", { ascending: false })
          .limit(5);
          
        if (ordersError || !orders || orders.length === 0) {
          console.error(`[Orders] No orders found: ${ordersError?.message || 'No orders'}`);
          return `Hello ${userData.username || 'there'}! You don't have any recent orders. To place an order, please visit our website at https://medihut.com`;
        }
        
        console.log(`[Orders] Found ${orders.length} orders directly from database`);
        
        // Format the response
        let formattedResponse = `📋 *Your Recent Orders*\n\n`;
        
        // Show up to 3 orders
        orders.slice(0, 3).forEach((order, index) => {
          const orderDate = order.created_at ? new Date(order.created_at).toLocaleDateString() : 'Unknown date';
          
          formattedResponse += `🧾 *Order #${order.id}*\n`;
          formattedResponse += `📅 Date: ${orderDate}\n`;
          formattedResponse += `📦 Status: ${order.status || 'Processing'}\n`;
          formattedResponse += `💰 *Total:* ₹${order.total_price || order.total_amount || 0}\n`;
          
          // Add separator between orders
          if (index < Math.min(orders.length, 3) - 1) {
            formattedResponse += `\n${'─'.repeat(20)}\n\n`;
          }
        });
        
        return formattedResponse;
      } catch (directError) {
        console.error(`[Orders] Direct database access failed: ${directError.message}`);
        return "Sorry, I couldn't fetch your recent orders. Please try again later.";
      }
    }
  } catch (error) {
    console.error(`[Orders] Unexpected error: ${error.message}`);
    return "Sorry, I encountered an error while retrieving your orders. Please try again later.";
  }
}

// Function to handle prescription uploads
async function handlePrescriptionUpload(fromNumber, mediaUrl, caption) {
  try {
    console.log(`Handling prescription upload from ${fromNumber} with media URL: ${mediaUrl}`);
    
    // Format the WhatsApp number to the standard format
    const formattedNumber = fromNumber.replace('whatsapp:', '');
    
    // Use the server's upload endpoint to process the prescription
    const response = await axios.post(`${SERVER_URL}/upload/upload-prescription`, {
      phone: formattedNumber,
      mediaUrl: mediaUrl,
      caption: caption || 'Prescription uploaded via WhatsApp'
    });
    
    if (response.data && response.data.success) {
      console.log('Prescription upload successful:', response.data);
      
      // Extract the prescription ID or reference number if available
      const referenceId = response.data.prescriptionId || response.data.referenceNumber || 'Unknown';
      
      return `Thank you for uploading your prescription! 
      
Your prescription has been received and is being processed. Reference #${referenceId}

Our team will review it shortly and get back to you with available medicines and pricing. You can check the status of your prescription by sending "Check prescription #${referenceId}".`;
    } else {
      console.error('Prescription upload failed:', response.data);
      return 'Sorry, we encountered an issue while processing your prescription. Please try again later or contact our customer support for assistance.';
    }
  } catch (error) {
    console.error('Error handling prescription upload:', error);
    
    // Fallback to direct handling if server API fails
    try {
      // Store the prescription details in Supabase as a fallback
      const { data, error: uploadError } = await supabase
        .from('prescriptions')
        .insert([
          {
            user_phone: fromNumber.replace('whatsapp:', ''),
            media_url: mediaUrl,
            caption: caption || 'Prescription uploaded via WhatsApp',
            status: 'pending',
            created_at: new Date()
          }
        ])
        .select();
      
      if (uploadError) {
        console.error('Supabase upload error:', uploadError);
        return 'Sorry, we encountered an issue while processing your prescription. Please try again later or contact our customer support for assistance.';
      }
      
      const prescriptionId = data && data[0] ? data[0].id : 'Unknown';
      
      return `Thank you for uploading your prescription!

Your prescription has been received and is being processed. Reference #${prescriptionId}

Our team will review it shortly and get back to you with available medicines and pricing.`;
    } catch (fallbackError) {
      console.error('Fallback upload error:', fallbackError);
      return 'Sorry, we encountered an issue while processing your prescription. Please try again later or contact our customer support for assistance.';
    }
  }
}

// Start the server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`WhatsApp bot server running on port ${PORT}`);
  console.log(`=================================================`);
  console.log(`WEBHOOK URL: ${process.env.NGROK_URL}/api/webhook`);
  console.log(`Set this in Twilio WhatsApp Sandbox settings.`);
  console.log(`=================================================`);
  console.log(`Twilio Phone: ${process.env.TWILIO_PHONE_NUMBER}`);
  console.log(`=================================================`);
  console.log(`Base server URL: ${SERVER_URL}`);
  console.log(`=================================================`);
  console.log(`Enhanced search functionality: ${searchMedicinesAPI && searchProductsAPI ? 'Enabled' : 'Disabled'}`);
  console.log(`=================================================`);
  
  // Test Twilio connection
  try {
    const testMessage = await twilioClient.messages.list({limit: 1});
    console.log(`✅ Successfully connected to Twilio! Account is working.`);
  } catch (error) {
    console.error(`❌ Error connecting to Twilio:`, error.message);
    console.log(`Check your Twilio credentials in .env file.`);
  }

  // Test API connectivity
  await testApiConnectivity();
});
