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

    // دالة تحويل الكائنات لنصوص لمنع مشاكل الـ Circular Structures
    function stringifyAll(obj) {
        const seen = new WeakSet();
        return JSON.stringify(obj, function (key, value) {
            if (typeof value === "bigint") return value.toString();
            if (typeof value === "function") return "[Function]";
            if (typeof value === "undefined") return "[Undefined]";
            if (typeof value === "object" && value !== null) {
                if (seen.has(value)) return "[Circular]";
                seen.add(value);
            }
            return value;
        }, 2);
    }

    // حدث استقبال الرسائل المطور والمؤمن صريحاً 🎯
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        const msg = messages[0];
        
        if (msg && !msg.key.fromMe && type === 'notify') {
            const isGroup = msg.key.remoteJid ? msg.key.remoteJid.endsWith('@g.us') : false;
            const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            if (!isGroup && messageText) {
                
                // 🧠 الحركة السحرية: سحب الرقم الحقيقي من remoteJidAlt فوراً، ولو مش موجود نرجع لـ remoteJid
                let rawJid = msg.key.remoteJidAlt && msg.key.remoteJidAlt !== "[Undefined]" ? msg.key.remoteJidAlt : msg.key.remoteJid;
                let realNumber = rawJid.split('@')[0];

                // تجهيز الـ Payload النظيف المتوافق مع الـ Web Forms بالملي
                const payload = {
                    messageId: msg.key.id,
                    senderNumber: realNumber, // هنا هيتبعت الـ 201006956328 الصريح والنظيف لأي مستخدم 🚀
                    senderName: msg.pushName || 'عميل مزاد إكس',
                    messageBody: messageText,
                    timestamp: msg.messageTimestamp
                };

                try {
                    await axios.post(MAZADX_WEBHOOK_URL, payload);
                    console.log(`[نجاح] تم تمرير الرسالة بنجاح من رقم العميل الفعلي: ${payload.senderNumber}`);
                } catch (error) {
                    console.error('خطأ أثناء تمرير الرسالة لـ الـ Web Forms:', error.message);
                }
            }
        }
    });
}

startWhatsApp();