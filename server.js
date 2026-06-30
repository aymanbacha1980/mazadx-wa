const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// 1. الإعدادات الخاصة بمنصة مزاد إكس والـ Supabase
const MAZADX_WEBHOOK_URL = 'https://rug-previous-mullets.ngrok-free.dev/ReceiveWhatsappWebhook.aspx'; 
const STORAGE_URL = 'https://dbbqpjglpqthxvkxhyrh.supabase.co/storage/v1/object/backups/auth_info.zip';
const SUPABASE_KEY = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRiYnFwamdscHF0aHh2a3hoeXJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MDc1MjEsImV4cCI6MjA5ODM4MzUyMX0.9MuIHlYrZ0gTyEUGcoaIU9wupNZbmKtiaA55-_3Jq74';

let isWhatsAppConnected = false; 
let isUploading = false;         
let sock;                        

// دالة لسحب ملف الجلسة وفك ضغطه عند بداية التشغيل
async function downloadSession() {
    try {
        console.log('جاري سحب ملف الجلسة من مخزن Supabase...');
        const response = await axios.get(STORAGE_URL, { headers: { 'Authorization': SUPABASE_KEY }, responseType: 'arraybuffer' });
        fs.writeFileSync('auth_info.zip', response.data);
        const AdmZip = require('adm-zip');
        const zip = new AdmZip('auth_info.zip');
        zip.extractAllTo(path.join(__dirname, 'auth_info'), true);
        fs.unlinkSync('auth_info.zip');
        console.log('تم تحميل وفك ضغط الجلسة بنجاح والأمور مستقرة.');
    } catch (err) {
        console.log('تنبيه: لم يتم العثور على جلسة سابقة، سيتم توليد باركود جديد.');
    }
}

// دالة لضغط مجلد الجلسة ورفعه
async function uploadSession() {
    if (!isWhatsAppConnected || isUploading) return;
    isUploading = true; 
    try {
        console.log('🔄 جاري حفظ وتحديث الجلسة النشطة في مخزن Supabase...');
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        const folderPath = path.join(__dirname, 'auth_info');
        if (fs.existsSync(folderPath)) {
            zip.addLocalFolder(folderPath);
            zip.writeZip('auth_info.zip');
            const fileData = fs.readFileSync('auth_info.zip');
            await axios.put(STORAGE_URL, fileData, { headers: { 'Authorization': SUPABASE_KEY, 'Content-Type': 'application/zip', 'x-upsert': 'true' } });
            fs.unlinkSync('auth_info.zip');
            console.log('✅ تم تحديث المخزن الخارجي بنجاح تام.');
        }
    } catch (err) {
        console.error('❌ فشل في تحديث ملف الجلسة خارجياً:', err.message);
    } finally {
        isUploading = false; 
    }
}

async function startWhatsApp() {
    await downloadSession();
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false 
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { console.log('--- امسح الباركود التالي برقم مزاد إكس ---'); qrcode.generate(qr, { small: true }); }
        if (connection === 'close') {
            isWhatsAppConnected = false;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            isWhatsAppConnected = true; 
            await uploadSession(); 
        }
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        if (isWhatsAppConnected) await uploadSession(); 
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const isGroup = msg.key.remoteJid.endsWith('@g.us');
            const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            if (!isGroup && messageText) {
                
                // 1. استخراج المعرف الأولي (LID)
                let rawJid = msg.key.remoteJid; 
                let realNumber = rawJid.split('@')[0];

                // 2. 🧠 تفتيش الميتا-داتا والـ vCard للرسالة لاستخراج رقم الموبايل الصريح لأي مستخدم
                try {
                    // إذا كان المعرف القادم هو LID (يبدأ بـ 86)
                    if (realNumber.startsWith('86') || rawJid.includes('@lid')) {
                        
                        // الفحص العبقري: البحث عن رقم الموبايل الحقيقي المرتبط بالحساب من الـ Context المباشر للرسالة
                        if (msg.key.participant) {
                            realNumber = msg.key.participant.split(':')[0].split('@')[0];
                        } 
                        // إذا لم يتوفر، نسحب الرقم من تفاصيل الـ user profile المخزنة في الـ memory للجلسة
                        else if (sock.vnameCount) {
                            const contact = await sock.getContact(rawJid);
                            if (contact && contact.id) {
                                realNumber = contact.id.split(':')[0].split('@')[0];
                            }
                        }
                    }
                } catch (err) {
                    console.error('تنبيه أثناء استخراج رقم الهاتف الحقيقي:', err.message);
                }

                // الـ Payload الحقيقي والموثق برقم الموبايل الصريح للمستخدم (201xxxxxxxx)
                const payload = {
                    messageId: msg.key.id,
                    senderNumber: realNumber, 
                    senderName: msg.pushName || 'عميل مزاد إكس',
                    messageBody: messageText,
                    timestamp: msg.messageTimestamp
                };

                try {
                    await axios.post(MAZADX_WEBHOOK_URL, payload);
                    console.log(`[مؤمن] تم تمرير الرسالة بنجاح من رقم المحمول الفعلي: ${payload.senderNumber}`);
                } catch (error) {
                    console.error('خطأ أثناء تمرير الرسالة لـ الـ Web Forms:', error.message);
                }
            }
        }
    });
}

startWhatsApp();