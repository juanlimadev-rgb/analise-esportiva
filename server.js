require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');

const connection = require('./database/connection');
const verificarToken = require('./middlewares/auth');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// -------------------------
// ROTA TESTE
// -------------------------
app.get('/', (req, res) => {
  res.send('API Moura Analytics online.');
});

// -------------------------
// HELPERS GERAIS
// -------------------------
function queryAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function getFiltroAtleta(tipo) {
  if (tipo === 'atleta1') return 'AND id_atleta = 1';
  if (tipo === 'atleta2') return 'AND id_atleta = 2';
  if (tipo === 'dupla') return 'AND id_atleta IN (1,2)';
  return null;
}

function calcularResultadoFinal(sets) {
  let setsDupla = 0;
  let setsAdversario = 0;

  for (const set of sets) {
    if (Number(set.pontos_dupla) > Number(set.pontos_adversario)) {
      setsDupla++;
    } else if (Number(set.pontos_adversario) > Number(set.pontos_dupla)) {
      setsAdversario++;
    }
  }

  return `${setsDupla} x ${setsAdversario}`;
}

function formatarDataBR(data) {
  if (!data) return '-';
  const dataObj = new Date(data);
  if (Number.isNaN(dataObj.getTime())) return '-';

  return dataObj.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Maceio'
  });
}

// -------------------------
// HELPERS ESPECÍFICOS PARA PDFKIT
// -------------------------
function formatarValorPdf(valor) {
  if (valor === null || valor === undefined || valor === '') return '-';
  if (typeof valor === 'number') {
    return Number.isInteger(valor) ? String(valor) : valor.toFixed(2);
  }
  return String(valor);
}

function formatarPercentualPdf(valor) {
  if (valor === null || valor === undefined) return '-';
  return `${formatarValorPdf(valor)}%`;
}

function formatarResultadoPdf(resultado) {
  const mapa = {
    ponto: 'Ponto',
    neutro: 'Neutro',
    bloqueado: 'Bloqueado',
    erro: 'Erro',
    ace: 'Ace',
    excelente: 'Excelente',
    bom: 'Bom',
    regular: 'Regular',
    ruim: 'Ruim',
    acao: 'Ação'
  };

  return mapa[resultado] || resultado;
}

function desenharTituloSecao(doc, titulo) {
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold')
    .fontSize(14)
    .fillColor('#0f172a')
    .text(titulo);
  doc.moveDown(0.4);
  doc.fillColor('black');
}

function desenharLinha(doc, y) {
  doc.moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .strokeColor('#cbd5e1')
    .stroke();
}

function verificarQuebraPagina(doc, alturaNecessaria = 40) {
  const limite = doc.page.height - doc.page.margins.bottom;
  if (doc.y + alturaNecessaria > limite) {
    doc.addPage();
  }
}

function desenharTabela(doc, colunas, linhas, opcoes = {}) {
  const x = opcoes.x || doc.page.margins.left;
  let y = opcoes.y || doc.y;
  const alturaLinha = opcoes.alturaLinha || 24;
  const padding = 6;

  const larguraTotal = colunas.reduce((acc, col) => acc + col.width, 0);

  const desenharCabecalho = () => {
    doc.save();
    doc.rect(x, y, larguraTotal, alturaLinha).fill('#0f172a');
    doc.fillColor('white').font('Helvetica-Bold').fontSize(9);

    let posX = x;
    for (const col of colunas) {
      doc.text(col.label, posX + padding, y + 7, {
        width: col.width - padding * 2,
        align: col.align || 'left'
      });
      posX += col.width;
    }

    doc.restore();
    y += alturaLinha;
  };

  desenharCabecalho();

  for (const linha of linhas) {
    verificarQuebraPagina(doc, alturaLinha + 10);

    if (y + alturaLinha > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      desenharCabecalho();
    }

    let posX = x;
    doc.font('Helvetica').fontSize(9).fillColor('black');

    for (let i = 0; i < colunas.length; i++) {
      const col = colunas[i];
      const texto = formatarValorPdf(linha[i]);

      doc.rect(posX, y, col.width, alturaLinha)
        .strokeColor('#cbd5e1')
        .stroke();

      doc.text(texto, posX + padding, y + 7, {
        width: col.width - padding * 2,
        align: col.align || 'left'
      });

      posX += col.width;
    }

    y += alturaLinha;
  }

  doc.y = y + 6;
}

function desenharBlocoInfo(doc, rotulo, valor, x, y, largura) {
  doc.roundedRect(x, y, largura, 42, 6).strokeColor('#cbd5e1').stroke();
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b').text(rotulo.toUpperCase(), x + 8, y + 6, {
    width: largura - 16
  });
  doc.font('Helvetica').fontSize(10).fillColor('black').text(formatarValorPdf(valor), x + 8, y + 20, {
    width: largura - 16
  });
}

// -------------------------
// LÓGICA DE DADOS (SQL)
// -------------------------
function gerarSqlEstatistica(fundamento, filtroAtleta = '') {
  let campoPonto = "resultado = 'ponto'";
  let campoAcerto = "resultado = 'ponto'";
  let campoErro = "resultado = 'erro'";
  let calcularAproveitamento = true;
  let calcularEficiencia = true;

  if (fundamento === 'saque') {
    campoPonto = "resultado = 'ace'";
    campoAcerto = "resultado IN ('ace', 'neutro')";
    campoErro = "resultado = 'erro'";
    calcularAproveitamento = false;
    calcularEficiencia = false;
  }

  if (fundamento === 'passe') {
    campoPonto = "0 = 1";
    campoAcerto = "resultado IN ('excelente', 'bom', 'regular')";
    campoErro = "resultado = 'erro'";
  }

  if (fundamento === 'defesa') {
    campoPonto = "0 = 1";
    campoAcerto = "resultado = 'excelente'";
    campoErro = "resultado = 'erro'";
  }

  if (fundamento === 'bloqueio') {
    campoPonto = "resultado = 'ponto'";
    campoAcerto = "resultado = 'ponto'";
    campoErro = "resultado = 'erro'";
    calcularAproveitamento = false;
    calcularEficiencia = false;
  }

  if (fundamento === 'ataque' || fundamento === 'side-out' || fundamento === 'contra-ataque') {
    campoPonto = "resultado = 'ponto'";
    campoAcerto = "resultado = 'ponto'";
    campoErro = "resultado IN ('erro', 'bloqueado')";
  }

  const sqlAproveitamento = calcularAproveitamento
    ? `COALESCE(ROUND((SUM(CASE WHEN ${campoAcerto} THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)) * 100, 2), 0)`
    : `NULL`;

  const sqlEficiencia = calcularEficiencia
    ? `COALESCE(ROUND(((SUM(CASE WHEN ${campoAcerto} THEN 1 ELSE 0 END) - SUM(CASE WHEN ${campoErro} THEN 1 ELSE 0 END)) / NULLIF(COUNT(*), 0)) * 100, 2), 0)`
    : `NULL`;

  return `
    SELECT
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN resultado = 'neutro' THEN 1 ELSE 0 END), 0) AS neutros,
    COALESCE(SUM(CASE WHEN ${campoPonto} THEN 1 ELSE 0 END), 0) AS pontos,
    COALESCE(SUM(CASE WHEN ${campoAcerto} THEN 1 ELSE 0 END), 0) AS acertos,
    COALESCE(SUM(CASE WHEN ${campoErro} THEN 1 ELSE 0 END), 0) AS erros,
      ${sqlAproveitamento} AS aproveitamento,
      ${sqlEficiencia} AS eficiencia
    FROM eventos_partida
    WHERE id_partida = ? ${filtroAtleta} AND fundamento = ?
  `;
}

function getResultadosPorFundamento() {
  return {
    ataque: ['ponto', 'neutro', 'bloqueado', 'erro'],
    saque: ['ace', 'neutro', 'erro'],
    passe: ['excelente', 'bom', 'regular', 'ruim', 'erro'],
    bloqueio: ['ponto', 'neutro', 'erro'],
    defesa: ['excelente', 'acao', 'erro'],
    'side-out': ['ponto', 'neutro', 'erro'],
    'contra-ataque': ['ponto', 'neutro', 'bloqueado', 'erro']
  };
}

async function buscarPartidaDoUsuario(idPartida, idUsuario) {
  const partidas = await queryAsync(
    'SELECT * FROM partidas WHERE id = ? AND id_usuario = ? LIMIT 1',
    [idPartida, idUsuario]
  );
  return partidas[0] || null;
}

async function buscarDadosRelatorio(idPartida, tipo, idUsuario) {
  const filtro = getFiltroAtleta(tipo);
  if (!filtro) throw new Error('Tipo de relatório inválido.');

  const partida = await buscarPartidaDoUsuario(idPartida, idUsuario);
  if (!partida) return null;

  const sets = await queryAsync(
    'SELECT * FROM sets_partida WHERE id_partida = ? ORDER BY set_numero ASC',
    [idPartida]
  );

  const fundamentos = ['ataque', 'saque', 'passe', 'bloqueio', 'defesa', 'side-out', 'contra-ataque'];
  const estatisticas = {};
  const detalhamento = {};
  const mapaResultados = getResultadosPorFundamento();

  for (const fundamento of fundamentos) {
    const sql = gerarSqlEstatistica(fundamento, filtro);
    const resultado = await queryAsync(sql, [idPartida, fundamento]);

    estatisticas[fundamento] = resultado[0] || { total: 0, neutros: 0, pontos: 0, erros: 0, aproveitamento: 0, eficiencia: 0 };

    const linhasDetalhe = await queryAsync(
      `SELECT resultado, COUNT(*) AS quantidade FROM eventos_partida WHERE id_partida = ? ${filtro} AND fundamento = ? GROUP BY resultado`,
      [idPartida, fundamento]
    );

    const base = {};
    for (const resultadoNome of mapaResultados[fundamento] || []) {
      base[resultadoNome] = 0;
    }
    for (const linha of linhasDetalhe) {
      base[linha.resultado] = Number(linha.quantidade) || 0;
    }
    detalhamento[fundamento] = base;
  }

  return { partida, sets, estatisticas, detalhamento };
}

function getTituloTipoRelatorio(tipo, partida) {
  if (tipo === 'atleta1') return `Relatório Individual - ${partida.atleta1 || 'Atleta 1'}`;
  if (tipo === 'atleta2') return `Relatório Individual - ${partida.atleta2 || 'Atleta 2'}`;
  return `Relatório da Dupla - ${partida.dupla || `${partida.atleta1} / ${partida.atleta2}`}`;
}

// -------------------------
// ROTA DO RELATÓRIO PDF (PDFKIT)
// -------------------------
app.get('/relatorio/:id_partida/:tipo/pdf', verificarToken, async (req, res) => {
  try {
    const idPartida = Number(req.params.id_partida);
    const tipo = req.params.tipo || 'dupla';

    const dados = await buscarDadosRelatorio(idPartida, tipo, req.usuario.id);

    if (!dados) {
      return res.status(404).json({ erro: 'Partida não encontrada.' });
    }

    const partida = dados.partida;
    const sets = dados.sets || [];
    const estatisticas = dados.estatisticas || {};
    const detalhamento = dados.detalhamento || {};

    const titulo = getTituloTipoRelatorio(tipo, partida);
    const nomeArquivo = `${titulo.replace(/[^\w\-]+/g, '_')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nomeArquivo}"`);

    const doc = new PDFDocument({
      size: 'A4',
      margin: 36
    });

    doc.pipe(res);

    // TOPO
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a').text(titulo);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('Moura Analytics - Relatório gerado automaticamente');
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1d4ed8').text(`Resultado final: ${formatarValorPdf(partida.resultado)}`);
    doc.moveDown(0.4);
    desenharLinha(doc, doc.y);
    doc.moveDown(0.8);

    // INFORMAÇÕES DA PARTIDA
    desenharTituloSecao(doc, 'Informações da Partida');
    const infoX = doc.page.margins.left;
    const infoY = doc.y;
    const gap = 12;
    const larguraCard = (doc.page.width - doc.page.margins.left - doc.page.margins.right - gap) / 2;

    const infos = [
      ['Campeonato', partida.campeonato || '-'],
      ['Local', partida.local || '-'],
      ['Adversário', partida.adversario || '-'],
      ['Data', formatarDataBR(partida.data_partida) || '-'],
      ['Atleta 1', partida.atleta1 || '-'],
      ['Atleta 2', partida.atleta2 || '-']
    ];

    for (let i = 0; i < infos.length; i++) {
      const coluna = i % 2;
      const linha = Math.floor(i / 2);
      const x = infoX + coluna * (larguraCard + gap);
      const y = infoY + linha * 52;
      desenharBlocoInfo(doc, infos[i][0], infos[i][1], x, y, larguraCard);
    }

    doc.y = infoY + Math.ceil(infos.length / 2) * 52 + 8;

    // SETS
    desenharTituloSecao(doc, 'Placares dos Sets');
    const linhasSets = sets.length
      ? sets.map((set) => [`Set ${formatarValorPdf(set.set_numero)}`, formatarValorPdf(set.pontos_dupla), formatarValorPdf(set.pontos_adversario)])
      : [['Nenhum set registrado.', '', '']];

    desenharTabela(doc, [
      { label: 'Set', width: 120, align: 'left' },
      { label: 'Pontos da Dupla', width: 160, align: 'center' },
      { label: 'Pontos do Adversário', width: 180, align: 'center' }
    ], linhasSets);

    // ESTATÍSTICAS
    desenharTituloSecao(doc, 'Estatísticas');
    const ordemFundamentos = [
      ['ataque', 'Ataque'], ['saque', 'Saque'], ['passe', 'Passe'],
      ['bloqueio', 'Bloqueio'], ['defesa', 'Defesa'], ['side-out', 'Side-out'], ['contra-ataque', 'Contra-ataque']
    ];

    const linhasEstatisticas = ordemFundamentos.map(([chave, nome]) => {
      const e = estatisticas[chave] || { total: 0, neutros: 0, pontos: 0, erros: 0, aproveitamento: 0, eficiencia: 0 };
      return [nome, e.total ?? 0, e.neutros ?? 0, e.pontos ?? 0, e.erros ?? 0, formatarPercentualPdf(e.aproveitamento), formatarPercentualPdf(e.eficiencia)];
    });

    desenharTabela(doc, [
      { label: 'Fundamento', width: 120, align: 'left' },
      { label: 'Total', width: 55, align: 'center' },
      { label: 'Neutro', width: 65, align: 'center' },
      { label: 'Pontos', width: 65, align: 'center' },
      { label: 'Erros', width: 60, align: 'center' },
      { label: 'Aproveitamento', width: 110, align: 'center' },
      { label: 'Eficiência', width: 90, align: 'center' }
    ], linhasEstatisticas);

    // DETALHAMENTO
    doc.addPage();
    desenharTituloSecao(doc, 'Detalhamento por Fundamento');

    for (const [chave, nome] of ordemFundamentos) {
      verificarQuebraPagina(doc, 120);
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text(nome);
      doc.moveDown(0.3);

      const detalhe = detalhamento[chave] || {};
      const linhasDetalhe = Object.entries(detalhe).length
        ? Object.entries(detalhe).map(([resultado, quantidade]) => [formatarResultadoPdf(resultado), quantidade])
        : [['Sem registros.', '0']];

      desenharTabela(doc, [
        { label: 'Resultado', width: 280, align: 'left' },
        { label: 'Quantidade', width: 180, align: 'center' }
      ], linhasDetalhe, { alturaLinha: 22 });
      doc.moveDown(0.3);
    }

    // RODAPÉ
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(`Documento gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Maceio' })}`, { align: 'center' });

    doc.end();
  } catch (error) {
    console.error('❌ Erro ao gerar PDF:', error);
    return res.status(500).json({ erro: 'Erro ao gerar PDF.', detalhe: error.message });
  }
});

// -------------------------
// AUTENTICAÇÃO E OUTRAS ROTAS
// -------------------------
app.post('/auth/cadastro', async (req, res) => {
  try {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Nome, email e senha são obrigatórios.' });

    const emailLimpo = String(email).trim().toLowerCase();
    const usuarioExistente = await queryAsync('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [emailLimpo]);
    if (usuarioExistente.length > 0) return res.status(409).json({ erro: 'Este email já está cadastrado.' });

    const senhaHash = await bcrypt.hash(senha, 10);
    const result = await queryAsync('INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)', [nome.trim(), emailLimpo, senhaHash]);

    return res.status(201).json({ mensagem: 'Usuário cadastrado com sucesso.', usuario: { id: result.insertId, nome, email: emailLimpo } });
  } catch (error) {
    return res.status(500).json({ erro: 'Erro ao cadastrar usuário.' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const usuarios = await queryAsync('SELECT * FROM usuarios WHERE email = ? LIMIT 1', [String(email).trim().toLowerCase()]);

    if (usuarios.length === 0 || !(await bcrypt.compare(senha, usuarios[0].senha_hash))) {
      return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    }

    const usuario = usuarios[0];
    const token = jwt.sign({ id: usuario.id, nome: usuario.nome, email: usuario.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, usuario: { id: usuario.id, nome: usuario.nome } });
  } catch (error) {
    return res.status(500).json({ erro: 'Erro ao fazer login.' });
  }
});

app.get('/auth/me', verificarToken, (req, res) => res.json({ usuario: req.usuario }));

// -------------------------
// PARTIDAS E EVENTOS
// -------------------------
app.post('/partidas', verificarToken, async (req, res) => {
  try {
    const { campeonato, local, adversario, data_partida, atleta1, atleta2 } = req.body;
    const sql = `INSERT INTO partidas (campeonato, local, adversario, data_partida, dupla, atleta1, atleta2, resultado, id_usuario) VALUES (?, ?, ?, ?, ?, ?, ?, 'Em andamento', ?)`;
    const result = await queryAsync(sql, [campeonato, local, adversario, data_partida, `${atleta1} / ${atleta2}`, atleta1, atleta2, req.usuario.id]);
    return res.status(201).json({ id_partida: result.insertId });
  } catch (error) {
    return res.status(500).json({ erro: 'Erro ao criar partida.' });
  }
});

app.get('/partidas', verificarToken, async (req, res) => {
  const result = await queryAsync('SELECT * FROM partidas WHERE id_usuario = ? ORDER BY data_partida DESC, id DESC', [req.usuario.id]);
  return res.json(result);
});

app.post('/partidas/:id/finalizar', verificarToken, async (req, res) => {
  try {
    const { sets } = req.body;
    const idPartida = req.params.id;
    await queryAsync('DELETE FROM sets_partida WHERE id_partida = ?', [idPartida]);
    for (const set of sets) {
      await queryAsync(`INSERT INTO sets_partida (id_partida, set_numero, pontos_dupla, pontos_adversario) VALUES (?, ?, ?, ?)`, [idPartida, set.set_numero, set.pontos_dupla, set.pontos_adversario]);
    }
    const final = calcularResultadoFinal(sets);
    await queryAsync('UPDATE partidas SET resultado = ? WHERE id = ?', [final, idPartida]);
    return res.json({ resultado: final });
  } catch (error) {
    return res.status(500).json({ erro: 'Erro ao finalizar.' });
  }
});

app.post('/evento', verificarToken, async (req, res) => {
  try {
    const { id_partida, id_atleta, set_numero, fundamento, resultado } = req.body;
    await queryAsync(`INSERT INTO eventos_partida (id_partida, id_atleta, set_numero, fundamento, resultado) VALUES (?, ?, ?, ?, ?)`, [id_partida, id_atleta, set_numero, fundamento, resultado]);
    return res.json({ mensagem: 'Evento salvo!' });
  } catch (error) {
    return res.status(500).json({ erro: 'Erro ao salvar evento.' });
  }
});

app.delete('/evento/ultimo/:id_partida', verificarToken, async (req, res) => {
  const ultimo = await queryAsync(`SELECT id FROM eventos_partida WHERE id_partida = ? ORDER BY id DESC LIMIT 1`, [req.params.id_partida]);
  if (ultimo.length) await queryAsync('DELETE FROM eventos_partida WHERE id = ?', [ultimo[0].id]);
  return res.json({ mensagem: 'Desfeito!' });
});

// -------------------------
// INICIALIZAÇÃO
// -------------------------
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));