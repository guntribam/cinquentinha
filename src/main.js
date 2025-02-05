import { Client, Databases } from 'node-appwrite';
import moment from 'moment-timezone';

/**
 * Função principal exportada para o Appwrite.
 */
export default async ({ req, res, log, error }) => {
  // 1. Inicia o client do Appwrite
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  const database = new Databases(client);
  const databaseId = "67a181ae00117541a360";
  const collectionId = "67a25399002c05c91fcc";

  // 2. Lê variáveis de ambiente do Telegram
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Chat padrão (opcional)

  // 3. Tenta parsear o corpo da requisição (Webhook do Telegram ou CRON)
  let body = {};
  try {
    body = JSON.parse(req.payload || '{}');
    log(body)
  } catch (err) {
    log('Erro ao fazer JSON.parse do req.payload', err);
  }

  // 4. Se for chamada de CRON (ex.: {"cron":true}), gera o ranking
  if (body.cron === true) {
    await rankingDia(database, databaseId, collectionId, BOT_TOKEN, DEFAULT_CHAT_ID);
    return res.json({ success: true, message: "Ranking gerado via CRON." });
  }

  // 5. Caso seja um update do Telegram (contém "update_id" e "message")
  if (body.update_id && body.message) {
    const msg = body.message;
    const text = msg.text || "";
    const chatId = msg.chat.id;
    log({msg, text, chatId})

    // Comando /start
    if (text.startsWith('/start')) {
      await sendTelegramMessage(BOT_TOKEN, chatId, 
        "✅ Bot iniciado!\n\n📌 Use `/ranking` para ver o ranking."
      );
      return res.json({ ok: true });
    }

    // Comando /ranking (imediato, solicitado pelo usuário)
    if (text.startsWith('/ranking')) {
      await rankingDia(database, databaseId, collectionId, BOT_TOKEN, chatId);
      return res.json({ ok: true });
    }

    // Mensagem no formato "23/63%"
    const regex = /^(\d+)\/(\d+)%$/;
    const match = text.match(regex);
    if (match) {
      const acertosDia = parseInt(match[1]);
      const percentualDia = parseFloat(match[2]);
      await salvarDadosNoAppwrite(
        database,
        databaseId,
        collectionId,
        msg.from,
        acertosDia,
        percentualDia
      );
      await sendTelegramMessage(BOT_TOKEN, chatId, 
        `📊 ${msg.from.first_name}, seus dados foram salvos com sucesso!`
      );
      return res.json({ ok: true });
    }
  }

  // Se não se encaixar em nada, retornamos ok.
  return res.json({ ok: true, message: "Nothing to process." });
};

/**
 * Envia mensagem ao Telegram usando fetch nativo (Node 18+).
 */
async function sendTelegramMessage(botToken, chatId, text, parseMode = null) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text
  };
  if (parseMode) {
    body.parse_mode = parseMode;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();

    // Opcional: logar a resposta do Telegram
    console.log("Resposta Telegram:", data);
  } catch (err) {
    console.error("Erro ao enviar mensagem ao Telegram:", err);
  }
}

/**
 * Salva ou atualiza dados no Appwrite, conforme seu exemplo anterior.
 */
async function salvarDadosNoAppwrite(
  database,
  databaseId,
  collectionId,
  from,
  acertosDia,
  percentualDia
) {
  try {
    const nomeUsuario = from.last_name
      ? `${from.first_name} ${from.last_name}`
      : from.first_name;

    const telegramId = from.id.toString();
    const dataAtual = moment().tz("America/Sao_Paulo").format("YYYY-MM-DD");

    const response = await database.listDocuments(databaseId, collectionId, [
      `equal('telefone', '${telegramId}')`
    ]);

    if (response.documents.length > 0) {
      // Se o doc existir, atualiza
      const doc = response.documents[0];
      await database.updateDocument(databaseId, collectionId, doc.$id, {
        questoes_do_dia: acertosDia,
        percentual_do_dia: percentualDia,
        ultima_data: dataAtual
      });
    } else {
      // Caso não exista, cria um novo
      await database.createDocument(databaseId, collectionId, 'unique()', {
        telefone: telegramId,
        dias: 1,
        questoes: 0,
        questoes_do_dia: acertosDia,
        percentual: percentualDia,
        percentual_do_dia: percentualDia,
        ultima_data: dataAtual
      });
    }
    console.log(`📊 Dados de ${nomeUsuario} foram atualizados no Appwrite!`);
  } catch (error) {
    console.error("Erro ao salvar dados no Appwrite:", error);
  }
}

/**
 * Gera e envia o ranking do dia (chamado via CRON ou manualmente via `/ranking`).
 */
async function rankingDia(database, databaseId, collectionId, botToken, chatId) {
  try {
    const dataAtual = moment().tz("America/Sao_Paulo").format("YYYY-MM-DD");
    const response = await database.listDocuments(databaseId, collectionId);

    let usuarios = response.documents.map(doc => {
      const dias = (doc.ultima_data === dataAtual) ? (doc.dias + 1) : 0;
      const questoes = doc.questoes + doc.questoes_do_dia;
      const percentual = doc.percentual_do_dia;  // Ajustar se quiser outra lógica

      return {
        $id: doc.$id,
        telefone: doc.telefone,
        dias,
        questoes,
        percentual
      };
    });

    // Ordena pelo maior "dias", depois "questoes"
    usuarios.sort((a, b) => (b.dias - a.dias) || (b.questoes - a.questoes));

    // Top 10
    const medalhas = ["🥇", "🥈", "🥉"];
    let mensagem = "🏆 *RANKING FINAL DO DIA* 🏆\n\n";
    usuarios.slice(0, 10).forEach((user, index) => {
      const medalha = medalhas[index] || "";
      mensagem += `${medalha} ${user.telefone} - ${user.dias} dias - ${user.questoes} questões - ${user.percentual}%\n`;
    });

    // Envia ranking ao chat
    await sendTelegramMessage(botToken, chatId, mensagem, "Markdown");

    // Reseta infos de quem não participou hoje
    for (const user of response.documents) {
      const novosDias = (user.ultima_data === dataAtual) 
        ? (user.dias + 1) 
        : 0;
      await database.updateDocument(databaseId, collectionId, user.$id, {
        dias: novosDias,
        questoes_do_dia: 0,
        percentual_do_dia: 0
      });
    }

    console.log("Ranking gerado e reset concluído!");
  } catch (error) {
    console.error("Erro ao gerar ranking e resetar usuários:", error);
  }
}
