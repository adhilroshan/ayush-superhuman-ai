import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import FuzzySet from 'fuzzyset.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
await prisma.$connect();
console.log("Connected to the database");

dotenv.config();
const fuzzyNames = new FuzzySet();
const fuzzyDepartments = new FuzzySet();
const fuzzyCities = new FuzzySet();
const fuzzyHospitals = new FuzzySet();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050;

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, MY_PHONE_NUMBER } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !MY_PHONE_NUMBER) {
    console.error('Missing Twilio configuration. Please set it in the .env file.');
    process.exit(1);
}

const NGROK_URL = 'https://3789-2401-4900-8843-c54b-bcae-e0a9-5bd4-4a96.ngrok-free.app';
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const RECEPTIONIST_QUESTIONS = [
    { key: "name", question: "अपना नाम बताइए।" },
    { key: "city", question: "आप Chhattisgarh ke किस शहर में अपॉइंटमेंट बुक करना चाहते हैं? कृपया शहर का नाम बताएं।" },
    { key: "hospitalName", question: "आप किस अस्पताल में अपॉइंटमेंट लेना चाहते हैं? कृपया अस्पताल का नाम बताएं।" },
    { key: "department", question: "आप किस विभाग के डॉक्टर से परामर्श करना चाहते हैं? उदाहरण के लिए, हड्डी रोग (ऑर्थोपेडिक्स), हृदय रोग (कार्डियोलॉजी), या अन्य।" },
    { key: "date", question: "आप किस तारीख को अपॉइंटमेंट लेना चाहते हैं? कृपया दिनांक बताएं।" },
    { key: "time", question: "आप किस समय अपॉइंटमेंट लेना चाहेंगे? हमारे पास सुबह, दोपहर और शाम के स्लॉट उपलब्ध हैं।" },
];

// State management for both websocket and call sessions
const sessionStates = new Map();


// Add time validation helper
class SessionState {
    constructor(sessionId, type = 'websocket') {
        this.sessionId = sessionId;
        this.type = type;
        this.currentQuestionIndex = 0;
        this.userResponses = {};
    }
}

async function loadFuzzyData() {
    const names = await prisma.name.findMany();
    names.forEach(name => fuzzyNames.add(name.name));

    const departments = await prisma.department.findMany();
    departments.forEach(department => fuzzyDepartments.add(department.name));

    const cities = await prisma.city.findMany();
    cities.forEach(city => fuzzyCities.add(city.name));

    const hospitals = await prisma.hospital.findMany();
    hospitals.forEach(hospital => fuzzyHospitals.add(hospital.name));
}

async function matchInput(fuzzySet, input) {
    const result = fuzzySet.get(input);
    if (result) {
        return result[0][1]; // Return the closest match
    }
    return input; // If no match, return the original input
}

const getFuzzySetForKey = (key) => {
    switch (key) {
        case 'name': return fuzzyNames;
        case 'department': return fuzzyDepartments;
        case 'city': return fuzzyCities;
        case 'hospitalName': return fuzzyHospitals;
        default: return null;
    }
};

const sendNextQuestion = async (openAiWs, sessionState) => {
    if (sessionState.currentQuestionIndex < RECEPTIONIST_QUESTIONS.length) {
        const { question, key } = RECEPTIONIST_QUESTIONS[sessionState.currentQuestionIndex];
        let userResponse = sessionState.userResponses[key] || '';
        
        if (userResponse) {
            const fuzzySet = getFuzzySetForKey(key);
            if (fuzzySet) {
                userResponse = await matchInput(fuzzySet, userResponse);
            }
            
            openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { 
                    type: 'message', 
                    role: 'user', 
                    content: [{ type: 'input_text', text: `आपने कहा था "${userResponse}". (Yes/No)` }] 
                }
            }));
        } else {
            openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] }
            }));
        }
    } else {
        console.log('✅ All questions answered:', JSON.stringify(sessionState.userResponses, null, 2));

        try {
            await prisma.appointment.create({ data: sessionState.userResponses });
            console.log('✅ Appointment saved successfully!');
            // Clean up session state
            sessionStates.delete(sessionState.sessionId);
        } catch (err) {
            console.error('❌ Error saving to DB:', err);
        }
    }
};

// WebSocket endpoint
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, async (connection, req) => {
        console.log('Client connected');
        const sessionId = Date.now().toString();
        const sessionState = new SessionState(sessionId, 'websocket');
        sessionStates.set(sessionId, sessionState);

        await loadFuzzyData();
        console.log("Fuzzy data loaded successfully");

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            sendNextQuestion(openAiWs, sessionState);
        });

        openAiWs.on('message', (data) => {
            const response = JSON.parse(data);
            
            if (response.type === 'conversation.item.create' && response.item?.role === 'assistant') {
                const key = RECEPTIONIST_QUESTIONS[sessionState.currentQuestionIndex].key;
                const responseText = response.item.content[0]?.text.trim().toLowerCase();
        
                if (!sessionState.userResponses[key]) {
                    sessionState.userResponses[key] = responseText;
                    sendNextQuestion(openAiWs, sessionState);
                } else {
                    if (responseText === "yes") {
                        sessionState.currentQuestionIndex++;
                        sendNextQuestion(openAiWs, sessionState);
                    } else if (responseText === "no") {
                        delete sessionState.userResponses[key];
                        openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: RECEPTIONIST_QUESTIONS[sessionState.currentQuestionIndex].question }] }
                        }));
                    } else {
                        openAiWs.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Please answer Yes or No. आपने कहा था "${sessionState.userResponses[key]}".` }] }
                        }));
                    }
                }
            }
        });

        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            sessionStates.delete(sessionState.sessionId);
            console.log('Client disconnected.');
        });
    });
});

// Call handling endpoints
fastify.post('/incoming-call', async (req, reply) => {
    const callSid = req.body.CallSid;
    const sessionState = new SessionState(callSid, 'call');
    sessionStates.set(callSid, sessionState);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Aditi', language: 'hi-IN' },"नमस्ते, सरकार अस्पताल नियुक्ति बुकिंग प्रणाली में कॉल करने के लिए धन्यवाद। मेरा नाम आयुषी है। मैं आपकी नियुक्ति बुक करने में सहायता करूंगी और आपके स्वास्थ्य से जुड़े किसी भी प्रश्न का उत्तर दूंगी।");
    twiml.gather({
        input: 'speech',
        action: '/process-call-response',
        speechTimeout: '3',
        hints: 'John,Deepanshu, Maria, Orthopedics, Cardiology, New York, Apollo Hospital, 2025-03-10, 10 AM, Yes, no,हां!, नहीं!',
        speechModel: 'phone_call',
        language: 'hi-IN'
    }).say({ voice: 'Polly.Aditi', language: 'hi-IN' },"कृपया शुरू करने के लिए अपना नाम कहें।");

    reply.header('Content-Type', 'text/xml');
    reply.send(twiml.toString());
});

fastify.post('/process-call-response', async (req, reply) => {
    const callSid = req.body.CallSid;
    const speechResult = req.body.SpeechResult?.trim() || '';
    console.log('🔹 Received SpeechResult:', speechResult);

    let sessionState = sessionStates.get(callSid);
    if (!sessionState) {
        sessionState = new SessionState(callSid, 'call');
        sessionStates.set(callSid, sessionState);
    }

    const key = RECEPTIONIST_QUESTIONS[sessionState.currentQuestionIndex]?.key;
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        if (!sessionState.userResponses[key]) {
            let processedResponse = speechResult;

            // Special handling for date and time
                // Use fuzzy matching for other fields
                const fuzzySet = getFuzzySetForKey(key);
                if (fuzzySet) {
                    processedResponse = await matchInput(fuzzySet, speechResult);
                }
            sessionState.userResponses[key] = processedResponse;

            twiml.gather({
                input: 'speech',
                action: '/process-call-response',
                speechTimeout: '3',
                speechModel: 'phone_call',
                language: 'hi-IN'
            }).say({ voice: 'Polly.Aditi', language: 'hi-IN' },`आपने कहा था "${processedResponse}". क्या यह सही है? कृपया हाँ या नहीं कहें।`);
        } else {
            if (speechResult.toLowerCase().includes("हा")) {
                sessionState.currentQuestionIndex++;
                
                if (sessionState.currentQuestionIndex < RECEPTIONIST_QUESTIONS.length) {
                    const nextQuestion = RECEPTIONIST_QUESTIONS[sessionState.currentQuestionIndex].question;
                    twiml.gather({
                        input: 'speech',
                        action: '/process-call-response',
                        speechTimeout: '3',
                        speechModel: 'phone_call',
                        language: 'hi-IN'
                    }).say({ voice: 'Polly.Aditi', language: 'hi-IN' },nextQuestion);
                } else {
                    try {
                        await prisma.appointment.create({  data: sessionState.userResponses });
                        twiml.say({ voice: 'Polly.Aditi', language: 'hi-IN' },"आपका अपॉइंटमेंट सफलतापूर्वक बुक हो गया है। Message आपके मोबाइल नंबर पर भेज दिया गया है।");
                        sessionStates.delete(callSid);
                    } catch (err) {
                        console.error('❌ Error saving to DB:', err);
                        twiml.say({ voice: 'Polly.Aditi', language: 'hi-IN' },"माफ़ कीजिए, लेकिन आपकी नियुक्ति निर्धारित करने में एक त्रुटि हुई। कृपया बाद में पुनः प्रयास करें।");
                    }
                    twiml.hangup();
                }
            } else if (speechResult.toLowerCase().includes("नहीं")) {
                delete sessionState.userResponses[key];
                twiml.gather({
                    input: 'speech',
                    action: '/process-call-response',
                    speechTimeout: '3',
                    speechModel: 'phone_call',
                    language: 'hi-IN'
                }).say({ voice: 'Polly.Aditi', language: 'hi-IN' },RECEPTIONIST_QUESTIONS[sessionState.currentQuestionIndex].question);
            } else {
                twiml.gather({
                    input: 'speech',
                    action: '/process-call-response',
                    speechTimeout: '3',
                    speechModel: 'phone_call',
                    language: 'hi-IN'
                }).say({ voice: 'Polly.Aditi', language: 'hi-IN' },`मुझे समझ नहीं आया। आपने कहा था "${sessionState.userResponses[key]}". क्या यह सही है? कृपया हाँ या नहीं कहें।`);
            }
        }

        // Add error recovery gather
        twiml.gather({
            input: 'speech',
            action: '/process-call-response',
            speechTimeout: '3',
            speechModel: 'phone_call',
            language: 'hi-IN'
        });

    } catch (error) {
        console.error('Error processing call:', error);
        twiml.say("I apologize, but there was an error processing your request. Please try again later.");
        twiml.hangup();
        sessionStates.delete(callSid);
    }

    reply.header('Content-Type', 'text/xml');
    reply.send(twiml.toString());
    
    console.log('🔹 Call SID:', callSid);
    console.log('🔹 Current Question:', RECEPTIONIST_QUESTIONS[sessionState.currentQuestionIndex]?.question);
    console.log('🔹 Current Responses:', JSON.stringify(sessionState.userResponses, null, 2));
});

fastify.post('/call-me', async (req, reply) => {
    try {
        await twilioClient.calls.create({
            url: `${NGROK_URL}/incoming-call`,
            to: MY_PHONE_NUMBER,
            from: TWILIO_PHONE_NUMBER
        });
        reply.send({ success: true, message: 'Call initiated successfully.' });
    } catch (error) {
        console.error('Error initiating call:', error);
        reply.status(500).send({ success: false, message: 'Failed to initiate call.' });
    }
});

fastify.listen({ port: PORT }, async (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
    await loadFuzzyData();
    console.log("Fuzzy data loaded successfully");
});