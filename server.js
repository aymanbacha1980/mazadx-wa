const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

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

    // 🎯 حدث الاستقبال اللي بيقص المصفوفة الكبيرة ويشكل الـ JSON المطلوب بالظبط
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        const msg = messages[0]; // التقاط أول كائن داخل المصفوفة الكبيرة
        
        if (msg && !msg.key.fromMe && type === 'notify') {
            const isGroup = msg.key.remoteJid ? msg.key.remoteJid.endsWith('@g.us') : false;
            const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            if (!isGroup && messageText) {
                
                // 🧠 قص واستبدال رقم الراسل: لو الـ remoteJidAlt متاح وفيه الرقم الحقيقي بنمسكه فوراً، وإلا بنرجع للأصل
                let rawJid = msg.key.remoteJidAlt && msg.key.remoteJidAlt !== "[Undefined]" ? msg.key.remoteJidAlt : msg.key.remoteJid;
                let realNumber = rawJid.split('@')[0];

                // 🛠️ قص وتشكيل القالب المطلوب بالملي وعمل الـ Mapping
                const payload = {
                    messageId: msg.key.id,
                    senderNumber: realNumber, // تم استبدال الـ LID بالرقم الحقيقي بنجاح هنا (مثال: 201006956328)
                    senderName: msg.pushName || 'عميل مزاد إكس',
                    messageBody: messageText,
                    timestamp: msg.messageTimestamp
                };

                // إرسال كائن الـ JSON النظيف المقصوص مباشرة
                try {
                    await axios.post(MAZADX_WEBHOOK_URL, payload);
                    console.log(`[تم القص والتمرير] بنجاح للرسالة: ${payload.messageId} من الرقم: ${payload.senderNumber}`);
                } catch (error) {
                    console.error('خطأ أثناء تمرير الـ JSON لـ الـ Web Forms:', error.message);
                }
            }
        }
    });
}

startWhatsApp();