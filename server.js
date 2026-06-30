const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// 1. الإعدادات الخاصة بمنصة مزاد إكس والـ Supabase (رابط الـ ngrok الموجه لصفحة الـ aspx الحالية)
const MAZADX_WEBHOOK_URL = 'https://rug-previous-mullets.ngrok-free.dev/ReceiveWhatsappWebhook.aspx'; 
const STORAGE_URL = 'https://dbbqpjglpqthxvkxhyrh.supabase.co/storage/v1/object/backups/auth_info.zip';
const SUPABASE_KEY = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRiYnFwamdscHF0aHh2a3hoeXJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MDc1MjEsImV4cCI6MjA5ODM4MzUyMX0.9MuIHlYrZ0gTyEUGcoaIU9wupNZbmKtiaA55-_3Jq74';

let isWhatsAppConnected = false; // المتغير الأساسي لتحديد حالة الاتصال بالواتساب
let isUploading = false;         // قفل الأمان لمنع التكرار وازدحام الطلبات
let sock;                        // جعل متغير الـ socket عاماً للوصول إليه من حدث الاستقبال

// دالة لسحب ملف الجلسة وفك ضغطه عند بداية التشغيل
async function downloadSession() {
    try {
        console.log('جاري سحب ملف الجلسة من مخزن Supabase...');
        const response = await axios.get(STORAGE_URL, { 
            headers: { 'Authorization': SUPABASE_KEY }, 
            responseType: 'arraybuffer' 
        });
        
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
            
            // استخدام PUT لتجاوز الـ Error 400 تماماً
            await axios.put(STORAGE_URL, fileData, {
                headers: { 
                    'Authorization': SUPABASE_KEY, 
                    'Content-Type': 'application/zip', 
                    'x-upsert': 'true' 
                }
            });
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
    
    // إسناد الكائن للمتغير العام
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false 
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('--- امسح الباركود التالي برقم مزاد إكس ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isWhatsAppConnected = false;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('انقطع الاتصال.. جاري إعادة المحاولة الإتوماتيكية:', shouldReconnect);
            if (shouldReconnect) {
                startWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('🔥 خط الدفاع الثاني لمزاد إكس يعمل الآن بأعلى كفاءة وسرعة!');
            isWhatsAppConnected = true; 
            await uploadSession(); 
        }
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        if (isWhatsAppConnected) { 
            await uploadSession(); 
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const isGroup = msg.key.remoteJid.endsWith('@g.us');
            const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

            if (!isGroup && messageText) {
                
                // 1. استخراج المعرف الافتراضي الأولي
                let rawJid = msg.key.remoteJid; 
                let realNumber = rawJid.split('@')[0];

                // 2. الحل الهندسي الحاسم لفصل الـ LID واستخراج الرقم الصريح لأي مستخدم
                try {
                    if (rawJid.includes('@lid') || realNumber.startsWith('86')) {
                        // أ) فحص حقل الـ participant المباشر بالرسالة
                        if (msg.key.participant) {
                            realNumber = msg.key.participant.split(':')[0].split('@')[0];
                        } 
                        // ب) الاستعلام الفوري العكسي من سيرفر الواتساب بالـ LID لمعرفة الـ JID الحقيقي المتصل به
                        else if (sock) {
                            const normalizedLid = jidNormalizedUser(rawJid);
                            const result = await sock.onWhatsApp(normalizedLid);
                            if (result && result.length > 0 && result[0].exists) {
                                realNumber = result[0].jid.split('@')[0];
                            }
                        }
                    }
                } catch (err) {
                    console.error('تنبيه أثناء فك التشفير العكسي للرقم:', err.message);
                }

                // الحفاظ على مسمى senderNumber ليتطابق بالملي مع استقبال صفحة الـ Web Forms
                const payload = {
                    messageId: msg.key.id,
                    senderNumber: realNumber, // هنا سيصل رقم الموبايل الحقيقي لأي مستخدم (201xxxxxxxx)
                    senderName: msg.pushName || 'عميل مزاد إكس',
                    messageBody: messageText,
                    timestamp: msg.messageTimestamp
                };

                try {
                    await axios.post(MAZADX_WEBHOOK_URL, payload);
                    console.log(`[خط الدفاع] تم تحويل الرسالة بنجاح من الرقم الحقيقي: ${payload.senderNumber}`);
                } catch (error) {
                    console.error('خطأ أثناء تمرير الرسالة لـ الـ Web Forms:', error.message);
                }
            }
        }
    });
}

startWhatsApp();