# MediHut WhatsApp Bot

A WhatsApp chatbot for MediHut Pharmacy e-commerce application that enables users to:
- Search for medicines
- Track orders
- View recent orders
- Get information about prescription requirements
- Contact customer support

## Setup Instructions

### Prerequisites
- Node.js (v14 or higher)
- Twilio account with WhatsApp Business API access
- ngrok or similar tunneling service for development

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in .env file:
```
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
BOT_PORT=3001
SERVER_URL=https://localhost:5001
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number
NGROK_URL=your_ngrok_url
```

### Starting the Bot Server

Development mode (with auto-reload):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

### Configuring Twilio Webhook

1. Start ngrok to expose your local server:
```bash
ngrok http 3001
```

2. Copy the HTTPS URL provided by ngrok and update your .env file:
```
NGROK_URL=https://your-unique-id.ngrok.io
```

3. Configure Twilio WhatsApp Sandbox:
   - Go to Twilio Console > Messaging > Try it > WhatsApp
   - Set the "When a message comes in" webhook URL to: `https://your-ngrok-url/api/webhook`
   - Set the HTTP method to POST

## Available Commands

Users can interact with the bot using the following commands:

- `Hello` or `Hi` - Get a welcome message and list of available commands
- `Search medicine [name]` - Search for medicines by name
- `Track order #[order-id]` - Track order status by ID
- `My recent orders` - View recent orders
- `Prescription help` - Get information about prescription medicines
- `Contact support` - Get customer support contact information

## How It Works

The WhatsApp bot connects to the main MediHut server to access the following functionality:

1. **Medicine Search**: Queries the `/api/medicines/search` endpoint to find medicines by name.
2. **Order Tracking**: Calls the `/orders/track/{orderId}` endpoint to get order status.
3. **User Verification**: Uses Supabase to verify users based on phone numbers.
4. **Recent Orders**: Retrieves order history directly from the Supabase database.

## Troubleshooting

- If the bot doesn't respond, check that your Twilio webhook is correctly configured
- Ensure both the bot server and main server are running
- Check the console logs for any connection errors
- Verify your Twilio credentials in the .env file
