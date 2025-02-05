import { Client, Databases } from 'node-appwrite';
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import moment from "moment-timezone";

export default async ({ req, res, log, error }) => {
  // You can use the Appwrite SDK to interact with other services
  // For this example, we're using the Users service
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');
  const users = new Users(client);

  // The req object contains the request data
  if (req.path === "/ping") {
    // Use res object to respond with text(), json(), or binary()
    // Don't forget to return a response!
    return res.text("Pong");
  }


  // Configuração do Telegram
  const TOKEN = "SEU_TELEGRAM_BOT_TOKEN";
  const CHAT_ID = "SEU_TELEGRAM_CHAT_ID";
  const bot = new TelegramBot(TOKEN, { polling: true });

  // Configuração do Appwrite
  // const client = new Client()
  //   .setEndpoint("https://cloud.appwrite.io/v1") //Aquele código que usa no link do appwrite
  //   .setProject("679ec825003109b1dc49") //Código do projeto
  //   //Tive que gerar essa chave doidona aqui no appwrite
  //   .setKey("standard_ff51eae676622efcc1041c84688e46a5284a0ab89bc75998cba61ab59d367f96e167b1b972dd3d74d6603bce78a81d0addcf8bfba94ef668bf684e4525ed9b9eb697755ce6289cd48c377132b7c6e8acda983824b3911540ff10af4cbd1c0ff52957c2a889046f63a17e10e1104ef82079dcec6d1c707115cb2e0b9bb843e916");

  const database = new Databases(client);
  const databaseId = "67a181ae00117541a360";
  const collectionId = "67a25399002c05c91fcc";

  // Comando /start pra testar se o bot responde
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "✅ Bot iniciado!\n\n📌 Use `/ranking` para ver o ranking.");
  });

  // Processa mensagens recebidas apenas se seguirem o formato específico (23/63%)
  bot.on("message", async (msg) => {
    const regex = /^(\d+)\/(\d+)%$/;
    const match = msg.text.match(regex);

    if (match) {
      const acertosDia = parseInt(match[1]);
      const percentualDia = parseFloat(match[2]);
      await salvarDadosNoAppwrite(msg.from.id.toString(), acertosDia, percentualDia, msg.from.first_name, msg.from.last_name);
      bot.sendMessage(msg.chat.id, `📊 ${msg.from.first_name}, seus dados foram salvos com sucesso!`);
    }
  });

};

// Função para salvar ou atualizar os dados no Appwrite
async function salvarDadosNoAppwrite(telegramId, acertosDia, percentualDia, firstName, lastName) {
  try {
    const nomeUsuario = lastName ? `${firstName} ${lastName}` : firstName;
    const dataAtual = moment().tz("America/Sao_Paulo").format("YYYY-MM-DD");
    const response = await database.listDocuments(databaseId, collectionId, [
      `equal('telefone', '${telegramId}')`
    ]);

    if (response.documents.length > 0) {
      const doc = response.documents[0];
      await database.updateDocument(databaseId, collectionId, doc.$id, {
        questoes_do_dia: acertosDia,
        percentual_do_dia: percentualDia,
        ultima_data: dataAtual
      });
    } else {
      await database.createDocument(databaseId, collectionId, "unique()", {
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

// Gera e envia o ranking às 23h, resetando usuários inativos
async function rankingDia() { 
  try {
    const dataAtual = moment().tz("America/Sao_Paulo").format("YYYY-MM-DD");
    const response = await database.listDocuments(databaseId, collectionId);
    let usuarios = response.documents.map(doc => ({
      telefone: doc.telefone,
      dias: doc.ultima_data === dataAtual ? doc.dias + 1 : 0,
      questoes: doc.questoes + doc.questoes_do_dia,
      percentual: doc.percentual_do_dia,
      nome: doc.telefone
    }));

    usuarios.sort((a, b) => b.dias - a.dias || b.questoes - a.questoes);
    const medalhas = ["🥇", "🥈", "🥉"];
    let mensagem = "🏆 *RANKING FINAL DO DIA* 🏆\n\n";
    usuarios.slice(0, 10).forEach((user, index) => {
      mensagem += `${medalhas[index] || ""} ${user.nome} - ${user.dias} dias - ${user.questoes} questões - ${user.percentual}%\n`;
    });

    bot.sendMessage(CHAT_ID, mensagem, { parse_mode: "Markdown" });

    // Atualiza o banco resetando usuários inativos
    for (const user of response.documents) {
      const novosDias = user.ultima_data === dataAtual ? user.dias + 1 : 0;
      await database.updateDocument(databaseId, collectionId, user.$id, {
        dias: novosDias,
        questoes_do_dia: 0,
        percentual_do_dia: 0
      });
    }
  } catch (error) {
    console.error("Erro ao gerar ranking e resetar usuários:", error);
  }
};
