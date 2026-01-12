
// supabase-client.js
// Cliente de Supabase para sincronización híbrida (Offline First)
// Soporte para AUTH, STORAGE y MULTI-TENANCY (Organización)

// CONFIGURACIÓN DE SUPABASE
// ¡REEMPLAZA ESTOS VALORES CON LOS DE TU PROYECTO DE SUPABASE!
var SUPABASE_URL = 'https://wkifrgqptfjnxnjzyaot.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndraWZyZ3FwdGZqbnhuanp5YW90Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxODA3NTEsImV4cCI6MjA4Mzc1Njc1MX0.U-r7TwEDN0eR2fSJi6BaMBnJinKp3pW4NrN-mtbNSkg';
var STORAGE_BUCKET = 'paq_images'; // Nombre del Bucket en Supabase

// Variables globales para el cliente de Supabase (no confundir con el SDK en window.supabase)
var supabaseClient = null; // Cliente creado con createClient()
var currentUser = null; // Usuario de Supabase Auth

function initSupabase() {
  // El SDK de Supabase desde CDN se expone como window.supabase.createClient
  if (!window.supabase || typeof window.supabase.createClient === 'undefined') {
    console.warn('Supabase SDK no cargado. Verifica que el CDN esté disponible.');
    return;
  }
  if (!supabaseClient) {
    try {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      console.log('Supabase inicializado.');

      // Recuperar sesión si existe
      supabaseClient.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          currentUser = session.user;
          console.log("Sesión recuperada:", currentUser.email);
          // checkUserRoleAndOrg(currentUser.id); // Opcional: refrescar metadatos
        }
      });

      // Escuchar cambios de auth
      supabaseClient.auth.onAuthStateChange((event, session) => {
        currentUser = session ? session.user : null;
        if (event === 'SIGNED_OUT') {
          // Limpiar datos locales sensibles si se desea, o mantener offline
          console.log("Sesión cerrada.");
        }
      });

    } catch (e) {
      console.error('Error al inicializar Supabase:', e);
    }
  }
}

// --- AUTHENTICATION ---

async function sbLogin(email, password) {
  if (!supabaseClient) return { error: 'Supabase no inicializado' };
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (data.user) currentUser = data.user;
  return { data, error };
}

/**
 * Registra un usuario. 
 * Si orgId está vacío, se asume que es ADMIN de una NUEVA organización (usando su ID como orgId).
 * Si orgId tiene valor, se asume que es GUARDIA uniéndose a esa organización.
 */
async function sbRegister(email, password, nombre) {
  if (!supabaseClient) return { error: 'Supabase no inicializado' };

  // 1. Crear usuario en Auth
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: nombre } // Metadata básica
    }
  });

  if (error) return { error };

  return { data, error: null };
}

async function sbLogout() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  currentUser = null;
}

// --- STORAGE ---

/**
 * Sube una imagen (Base64 o File) al bucket.
 * Retorna la URL pública.
 */
async function uploadImageToBucket(fileOrBase64, fileName) {
  if (!supabaseClient || !navigator.onLine) return null;

  try {
    let fileToUpload = fileOrBase64;

    // Convertir Base64 a Blob si es necesario
    if (typeof fileOrBase64 === 'string' && fileOrBase64.includes('base64')) {
      const arr = fileOrBase64.split(',');
      const mime = arr[0].match(/:(.*?);/)[1];
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) { u8arr[n] = bstr.charCodeAt(n); }
      fileToUpload = new Blob([u8arr], { type: mime });
    }

    const { data, error } = await supabaseClient.storage
      .from(STORAGE_BUCKET)
      .upload(fileName, fileToUpload, {
        cacheControl: '3600',
        upsert: true
      });

    if (error) {
      console.error('[Storage] Error subiendo imagen:', error);
      return null;
    }

    // Obtener URL pública
    const { data: { publicUrl } } = supabaseClient.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(fileName);

    return publicUrl;

  } catch (err) {
    console.error('[Storage] Excepción:', err);
    return null;
  }
}


// --- SYNC ---

/**
 * Sincroniza una tabla considerando organization_id.
 * Sube imágenes pendientes si encuentra Base64 pero no URL.
 */
async function syncTable(tableName, orgId) {
  if (!supabaseClient || !orgId) return;
  if (!navigator.onLine) {
    console.log(`[Sync] Offline. Omitiendo sync de ${tableName}.`);
    return;
  }

  console.log(`[Sync] Iniciando sync de ${tableName} (Org: ${orgId})...`);

  try {
    const localData = await getAll(tableName);
    // Filtrar solo datos de SU organización para subir
    const myMsgData = localData.filter(d => d.organization_id === orgId);

    // --- FASE 0: SUBIDA DE IMÁGENES PENDIENTES ---
    // Si hay items con foto (Base64) pero sin foto_url (Cloud), subir primero.
    if (tableName === 'paquetes' || tableName === 'users') {
      for (const item of myMsgData) {
        let updated = false;

        // FOTO PRINCIPAL
        if (item.foto && item.foto.startsWith('data:') && !item.foto_cloud_url) {
          console.log(`[Sync] Subiendo foto para ${item.guia || item.usuario}...`);
          const fileName = `${orgId}/${tableName}/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
          const url = await uploadImageToBucket(item.foto, fileName);
          if (url) {
            item.foto_cloud_url = url;
            // Opcional: Limpiar base64 local para ahorrar espacio? 
            // item.foto = null; // No recomendado si queremos full offline functionality sin cache complejo
            updated = true;
          }
        }

        // FOTO FIRMA (solo paquetes)
        if (item.firma && item.firma.startsWith('data:') && !item.firma_cloud_url) {
          const fileName = `${orgId}/${tableName}/firmas/${Date.now()}_${item.guia || 'firma'}.png`;
          const url = await uploadImageToBucket(item.firma, fileName);
          if (url) { item.firma_cloud_url = url; updated = true; }
        }

        // FOTO ID (solo paquetes)
        if (item.idFoto && item.idFoto.startsWith('data:') && !item.idFoto_cloud_url) {
          const fileName = `${orgId}/${tableName}/ids/${Date.now()}_${item.guia || 'id'}.jpg`;
          const url = await uploadImageToBucket(item.idFoto, fileName);
          if (url) { item.idFoto_cloud_url = url; updated = true; }
        }

        if (updated) {
          await putItem(tableName, item); // Guardar URL en local antes de subir registro
        }
      }
    }

    // --- FASE 1: DESCARGAR ---
    const { data: remoteData, error } = await supabaseClient
      .from(tableName)
      .select('*')
      .eq('organization_id', orgId); // SOLO DATOS DE MI ORG

    if (error) throw error;

    // --- FASE 2: SUBIR (Upsert) ---
    // "Last Write Wins" simple o "Upload missing".
    // Estrategia: Subir lo que tengo en local que no esté en remoto (o actualizado).

    // Para simplificar, hacemos UPSERT de todo lo local modificado recientemente hacia la nube.
    // Lo ideal es tener un campo 'synced_at'. 
    // Haremos Upsert de todos los locales hacia la nube para asegurar.

    if (myMsgData.length > 0) {
      // Limpiamos IDs numéricos locales si Supabase usa UUID o Identity, 
      // PERO necesitamos match. Usaremos 'guia' (paquetes) o 'email/usuario' (users) como clave lógica.

      const updates = myMsgData.map(local => {
        const up = { ...local };
        delete up.id; // Dejar que Supabase maneje el ID primario, o usarlo si coincide
        // Asegurar org_id
        up.organization_id = orgId;
        return up;
      });

      // Upsert en lotes
      // Nota: onConflict debe coincidir con una restricción UNIQUE en Supabase.
      // Paquetes: 'guia', organization_id (si la guia es unica por org)
      // Users: 'usuario', organization_id

      // Como no conocemos las constraints exactas del usuario, intentaremos un insert/upsert generico.
      const conflictKey = (tableName === 'paquetes') ? 'guia' : (tableName === 'users' ? 'email' : 'id');
      // Nota: 'email' en users tabla custom, no auth.users

      if (updates.length > 0) {
        // Filtrar claves invalidas para upsert si no hay constraint
        // Simplemente subimos lo que podamos.
        const { error: upsertError } = await supabaseClient.from(tableName).upsert(updates, { onConflict: conflictKey, ignoreDuplicates: false });
        if (upsertError) console.warn(`[Sync] Warning upserting ${tableName}:`, upsertError.message);
      }
    }

    console.log(`[Sync] ${tableName} sincronizado.`);

  } catch (err) {
    console.error(`[Sync] Error sincronizando ${tableName}:`, err);
  }
}

async function syncAll(orgId) {
  if (!orgId) return;
  await syncTable('users', orgId); // Tabla pública de usuarios (perfiles)
  await syncTable('domicilios', orgId);
  await syncTable('paquetes', orgId);
  await syncTable('historial', orgId);
}
