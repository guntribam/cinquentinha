import { Client, Databases, Query } from 'node-appwrite';
import moment from 'moment-timezone';

export default async ({ req, res, log, error }) => {
  // 1. Inicia o cliente do Appwrite
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');

  // 2. Define Database e Collection
  const database = new Databases(client);
  const databaseId = process.env.DATABASE_ID;   
  const collectionId = process.env.COLLECTION_ID; 

  // 3. Variáveis de ambiente do Telegram
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  // 4. Lê o body da requisição
  const body = req.bodyJson ?? {};
  log(`init-body-------\n${JSON.stringify(body, null, 2)}\nend-body-------`);

  // 5. Se for CRON (por ex.: {"cron": true}), gera o ranking
  if (body.cron === true) {
    await rankingDia(database, databaseId, collectionId, BOT_TOKEN, DEFAULT_CHAT_ID);
    return res.json({ success: true, message: "Ranking gerado via CRON." });
  }

  // 6. Se for update do Telegram
  if (body.update_id && body.message) {
    const msg = body.message;
    const text = msg.text || "";
    const chatId = msg.chat.id;

    // /start
    if (text.startsWith('/start')) {
      await sendTelegramMessage(BOT_TOKEN, chatId, 
        "✅ Bot iniciado!\n\n📌 Use `/ranking` para ver o ranking."
      );
      return res.json({ ok: true });
    }

    // /ranking
    if (text.startsWith('/ranking')) {
      await rankingDia(database, databaseId, collectionId, BOT_TOKEN, chatId);
      return res.json({ ok: true });
    }

    // Mensagem no formato "NN/PP%"
    const regex = /^(\d+)\/(\d+)$/;
    const match = text.match(regex);
    if (match) {
      const questoesDia = parseInt(match[1]);
      const acertosDia = parseFloat(match[2]);

      let msgToSend =  "Jaspion"
      try {
        await salvarDadosNoAppwrite(
          database,
          databaseId,
          collectionId,
          msg.from,         
          questoesDia,
          acertosDia
        );
        msgToSend = `📊 ${msg.from.first_name}, seus dados foram salvos com sucesso!`
        log(msg.from)
      } catch (dbError) {
        error(dbError)
        msgToSend = `😱 houve um bug!!!`
      }
      await sendTelegramMessage(BOT_TOKEN, chatId, msgToSend);
      return res.json({ ok: true });
    }
  }

  // 7. Se não se encaixa em nada
  return res.json({ ok: true, message: "Nothing to process." });
};

/**
 * Salva/atualiza documento do usuário no Appwrite.
 */
async function salvarDadosNoAppwrite(database, databaseId, collectionId, from, questoesDia, acertosDia) {
  try {
    const telegramId = from.id.toString();
    const hoje = moment().tz("America/Sao_Paulo").format("YYYY-MM-DD");
    const ontem = moment().tz("America/Sao_Paulo").subtract(1, 'day').format("YYYY-MM-DD");

    // Busca doc do usuário
    const response = await database.listDocuments(databaseId, collectionId, [
      Query.equal('telegram_id', `${telegramId}`)
    ]);

    // Se não existir, cria do zero
    if (response.documents.length === 0) {
      await database.createDocument(databaseId, collectionId, 'unique()', {
        telegram_id: telegramId,
        whoami: `${from.first_name || 'nameless'}${telegramId.slice(-2)}`,
        dias: 1,
        questoes: questoesDia,
        acertos: acertosDia,
        ultima_data: hoje
      });
      console.log(`Criado: ${from.first_name} (novo usuário).`);
      return;
    }

    // Senão, atualiza
    const doc = response.documents[0];
    let novoDias = doc.dias;
    let novaQtdQuestoes = questoesDia;
    let novaQtdAcertos = acertosDia;

    // Verifica se continua streak
    if (doc.ultima_data === ontem) {
      novoDias++;
      novaQtdQuestoes += doc.questoes
      novaQtdAcertos += doc.acertos
    } else if (doc.ultima_data !== hoje) {
      novoDias = 1;
      novaQtdQuestoes += doc.questoes
      novaQtdAcertos += doc.acertos
    } 
    
    await database.updateDocument(databaseId, collectionId, doc.$id, {
      dias: novoDias,
      whoami: doc.whoami,
      questoes: novaQtdQuestoes,
      acertos: novaQtdAcertos,
      ultima_data: hoje
    });
    console.log(`Atualizado: ${from.first_name} (streak: ${novoDias}, questoes: ${novaQtdQuestoes}).`);
  } catch (error) {
    console.error("Erro ao salvar dados no Appwrite:", error);
    throw error
  }
}

/**
 * Gera e envia o ranking do dia, chamando via CRON ou manualmente (/ranking).
 */
async function rankingDia(database, databaseId, collectionId, botToken, chatId) {
  try {
    const hoje = moment().tz("America/Sao_Paulo").format("YYYY-MM-DD");
    const response = await database.listDocuments(databaseId, collectionId);

    // 1) Para cada doc, zera "dias" se não enviou hoje
    //    (ou seja, se ultima_data != hoje => dias=0)
    //    mas antes capturamos os dados para exibir o ranking "pré-reset" ou "pós-reset",
    //    depende da sua preferência. Aqui, vamos exibir com o streak atualizado:
    let usuarios = [];
    for (const doc of response.documents) {
      // Se não postou hoje, streak = 0
      let diasAtual = (doc.ultima_data === hoje) ? doc.dias : 0;

      

      usuarios.push({
        $id: doc.$id,
        telegram_id: doc.telegram_id,
        dias: diasAtual,
        questoes: doc.questoes,
        acertos: doc.acertos,
      });
    }

    // 2) Ordena => maior `dias`, depois `questoes`, depois `percentual`
    usuarios.sort((a, b) => {
      if (b.dias !== a.dias) return b.dias - a.dias;
      if (b.questoes !== a.questoes) return b.questoes - a.questoes;
      return b.acertos - a.acertos;
    });

    // 3) Monta mensagem do ranking
    const medalhas = ["🥇", "🥈", "🥉"];
    let mensagem = "🏆 *RANKING FINAL DO DIA* 🏆\n\n";
    usuarios.forEach((user, index) => {
      const medalha = medalhas[index] || `${index+1}º)`;
      mensagem += `${medalha} [${user.telegram_id}] - ` + 
                  `${user.dias} dias - ` +
                  `${user.questoes} questões - ` +
                  `${user.acertos} acertos\n`;
    });

    // 4) Envia ranking
    await sendTelegramMessage(botToken, chatId, mensagem, "Markdown");

    // 5) Agora persiste "dias=0" em quem não enviou hoje (reset real no banco).
    const promises = response.documents
      .filter((doc) => doc.ultima_data !== hoje)
      .map((doc) => {
        return database.updateDocument(databaseId, collectionId, doc.$id, {
          dias: 0
        });
      });

    await Promise.all(promises);

    console.log("Ranking gerado e reset concluído!");
  } catch (error) {
    console.error("Erro ao gerar ranking e resetar usuários:", error);
  }
}

/**
 * Envia mensagem ao Telegram (usando fetch nativo em Node 18+).
 */
async function sendTelegramMessage(botToken, chatId, text, parseMode = null) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    console.log("Resposta do Telegram:", data);
  } catch (err) {
    console.error("Erro ao enviar mensagem ao Telegram:", err);
  }
}
