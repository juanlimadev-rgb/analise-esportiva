require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');

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
// HELPERS
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

function gerarSqlEstatistica(fundamento, filtroAtleta = '') {
  let campoPonto = "resultado = 'ponto'";
  let campoAcerto = "resultado = 'ponto'";
  let campoErro = "resultado = 'erro'";
  let calcularAproveitamento = true;
  let calcularEficiencia = true;

  // SAQUE
  // Ace = ponto
  // Ace e neutro = acerto
  // Erro = erro
  // Sem aproveitamento e sem eficiência
  if (fundamento === 'saque') {
    campoPonto = "resultado = 'ace'";
    campoAcerto = "resultado IN ('ace', 'neutro')";
    campoErro = "resultado = 'erro'";
    calcularAproveitamento = false;
    calcularEficiencia = false;
  }

  // PASSE
  // Excelente, bom e regular = acerto
  // Ruim só entra no total
  // Erro = erro
  if (fundamento === 'passe') {
    campoPonto = "0 = 1";
    campoAcerto = "resultado IN ('excelente', 'bom', 'regular')";
    campoErro = "resultado = 'erro'";
  }

  // DEFESA
  // Excelente = acerto
  // Ação só entra no total
  // Erro = erro
  if (fundamento === 'defesa') {
    campoPonto = "0 = 1";
    campoAcerto = "resultado = 'excelente'";
    campoErro = "resultado = 'erro'";
  }

  // BLOQUEIO
  // Ponto = ponto e acerto
  // Neutro só entra no total
  // Erro = erro
  // Sem aproveitamento e sem eficiência
    if (fundamento === 'bloqueio') {
      campoPonto = "resultado = 'ponto'";
      campoAcerto = "resultado = 'ponto'";
      campoErro = "resultado = 'erro'";
      calcularAproveitamento = false;
      calcularEficiencia = false;
    }

  // ATAQUE
  // Ponto = ponto e acerto
  // Neutro só entra no total
  // Bloqueado e erro = erro
  if (fundamento === 'ataque') {
    campoPonto = "resultado = 'ponto'";
    campoAcerto = "resultado = 'ponto'";
    campoErro = "resultado IN ('erro', 'bloqueado')";
  }

  // SIDE-OUT
  // Ponto = ponto e acerto
  // Neutro só entra no total
  // Erro = erro
    if (fundamento === 'side-out') {
    campoPonto = "resultado = 'ponto'";
    campoAcerto = "resultado = 'ponto'";
    campoErro = "resultado IN ('erro', 'bloqueado')";
  }

  // CONTRA-ATAQUE
  // Ponto = ponto e acerto
  // Neutro só entra no total
  // Bloqueado e erro = erro
  if (fundamento === 'contra-ataque') {
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
  if (!filtro) {
    throw new Error('Tipo de relatório inválido.');
  }

  const partida = await buscarPartidaDoUsuario(idPartida, idUsuario);
  if (!partida) {
    return null;
  }

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

    estatisticas[fundamento] = resultado[0] || {
      total: 0,
      neutros: 0,
      pontos: 0,
      erros: 0,
      aproveitamento: 0,
      eficiencia: 0
    };

    const linhasDetalhe = await queryAsync(
      `
      SELECT resultado, COUNT(*) AS quantidade
      FROM eventos_partida
      WHERE id_partida = ? ${filtro} AND fundamento = ?
      GROUP BY resultado
      `,
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

  return {
    partida,
    sets,
    estatisticas,
    detalhamento
  };
}

function escapeHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatarNumero(valor) {
  const numero = Number(valor || 0);
  return Number.isInteger(numero) ? String(numero) : numero.toFixed(2);
}

function gerarLinhasSets(sets = []) {
  if (!sets.length) {
    return `
      <tr>
        <td colspan="3">Nenhum set registrado.</td>
      </tr>
    `;
  }

  return sets.map(set => `
    <tr>
      <td>${escapeHtml(set.set_numero)}</td>
      <td>${escapeHtml(set.pontos_dupla)}</td>
      <td>${escapeHtml(set.pontos_adversario)}</td>
    </tr>
  `).join('');
}

function formatarValorRelatorio(valor) {
  if (valor === null || valor === undefined) return '-';
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return '-';
  return Number.isInteger(numero) ? String(numero) : numero.toFixed(2);
}

function gerarLinhasEstatisticas(estatisticas = {}) {
  const ordem = [
    { chave: 'ataque', nome: 'Ataque' },
    { chave: 'saque', nome: 'Saque' },
    { chave: 'passe', nome: 'Passe' },
    { chave: 'bloqueio', nome: 'Bloqueio' },
    { chave: 'defesa', nome: 'Defesa' },
    { chave: 'side-out', nome: 'Side-out' },
    { chave: 'contra-ataque', nome: 'Contra-ataque' }
  ];

  return ordem.map(item => {
    const e = estatisticas[item.chave] || {
      total: 0,
      neutros: 0,
      pontos: 0,
      erros: 0,
      aproveitamento: null,
      eficiencia: null
    };

    return `
      <tr>
        <td>${item.nome}</td>
        <td>${e.total}</td>
        <td>${e.neutros}</td>
        <td>${e.pontos}</td>
        <td>${e.erros}</td>
        <td>${e.aproveitamento === null ? '-' : e.aproveitamento + '%'}</td>
        <td>${e.eficiencia === null ? '-' : e.eficiencia + '%'}</td>
      </tr>
    `;
  }).join('');
}

function getTituloTipoRelatorio(tipo, partida) {
  if (tipo === 'atleta1') return `Relatório Individual - ${partida.atleta1 || 'Atleta 1'}`;
  if (tipo === 'atleta2') return `Relatório Individual - ${partida.atleta2 || 'Atleta 2'}`;
  return `Relatório da Dupla - ${partida.dupla || `${partida.atleta1} / ${partida.atleta2}`}`;
}

function formatarResultadoRelatorio(resultado) {
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

function gerarBlocosDetalhamento(detalhamento = {}) {
  const ordem = [
    { chave: 'ataque', nome: 'Ataque' },
    { chave: 'saque', nome: 'Saque' },
    { chave: 'passe', nome: 'Passe / Recepção' },
    { chave: 'bloqueio', nome: 'Bloqueio' },
    { chave: 'defesa', nome: 'Defesa' },
    { chave: 'side-out', nome: 'Side-out' },
    { chave: 'contra-ataque', nome: 'Contra-ataque' }
  ];

  return ordem.map(({ chave, nome }) => {
    const resultados = detalhamento[chave] || {};

    const linhas = Object.entries(resultados).map(([resultado, quantidade]) => `
      <tr>
        <td>${escapeHtml(formatarResultadoRelatorio(resultado))}</td>
        <td>${escapeHtml(quantidade)}</td>
      </tr>
    `).join('');

    return `
      <div class="bloco-detalhe evitar-quebra">
        <h3>${escapeHtml(nome)}</h3>
        <table>
          <thead>
            <tr>
              <th>Resultado</th>
              <th>Quantidade</th>
            </tr>
          </thead>
          <tbody>
            ${linhas || `
              <tr>
                <td colspan="2">Sem registros.</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    `;
  }).join('');
}

function gerarHtmlRelatorio({ partida, sets, estatisticas, detalhamento, tipo }) {
  const titulo = getTituloTipoRelatorio(tipo, partida);

  return `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(titulo)}</title>
    <style>
        .page-break {
      page-break-before: always;
    }

    .evitar-quebra {
      page-break-inside: avoid;
    }
      * {
        box-sizing: border-box;
      }

      body {
        font-family: Arial, Helvetica, sans-serif;
        margin: 0;
        padding: 28px;
        color: #1f2937;
        background: #ffffff;
      }

      .topo {
        border-bottom: 3px solid #0f172a;
        padding-bottom: 14px;
        margin-bottom: 24px;
      }

      .titulo {
        font-size: 28px;
        font-weight: 700;
        margin: 0 0 8px 0;
        color: #0f172a;
      }

      .subtitulo {
        font-size: 13px;
        color: #475569;
        margin: 0;
      }

      .bloco {
        margin-bottom: 22px;
      }

      .bloco h2 {
        margin: 0 0 12px 0;
        font-size: 18px;
        color: #0f172a;
        border-left: 5px solid #2563eb;
        padding-left: 10px;
      }

      .grid-info {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px 18px;
      }

      .info-card {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 12px 14px;
      }

      .info-label {
        font-size: 12px;
        color: #64748b;
        margin-bottom: 4px;
        text-transform: uppercase;
        font-weight: 700;
      }

      .info-value {
        font-size: 15px;
        color: #0f172a;
        font-weight: 600;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 10px;
      }

      th, td {
        border: 1px solid #cbd5e1;
        padding: 10px;
        font-size: 13px;
        text-align: center;
      }

      th {
        background: #0f172a;
        color: white;
        font-weight: 700;
      }

      tr:nth-child(even) td {
        background: #f8fafc;
      }

      .rodape {
        margin-top: 28px;
        padding-top: 14px;
        border-top: 1px solid #cbd5e1;
        font-size: 12px;
        color: #64748b;
        text-align: center;
      }

      .resultado-destaque {
        display: inline-block;
        margin-top: 8px;
        padding: 10px 14px;
        background: #dbeafe;
        color: #1d4ed8;
        border-radius: 10px;
        font-weight: 700;
        font-size: 16px;
      }

      .bloco-detalhe {
        margin-bottom: 18px;
      }

      .bloco-detalhe h3 {
        margin: 0 0 8px 0;
        font-size: 15px;
        color: #1e293b;
      }
    </style>
  </head>
  <body>
    <div class="topo">
      <h1 class="titulo">${escapeHtml(titulo)}</h1>
      <p class="subtitulo">Moura Analytics - Relatório gerado automaticamente</p>
      <div class="resultado-destaque">Resultado final: ${escapeHtml(partida.resultado || '-')}</div>
    </div>

    <div class="bloco">
      <h2>Informações da Partida</h2>
      <div class="grid-info">
        <div class="info-card">
          <div class="info-label">Campeonato</div>
          <div class="info-value">${escapeHtml(partida.campeonato || '-')}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Local</div>
          <div class="info-value">${escapeHtml(partida.local || '-')}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Adversário</div>
          <div class="info-value">${escapeHtml(partida.adversario || '-')}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Data</div>
          <div class="info-value">${escapeHtml(formatarDataBR(partida.data_partida))}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Atleta 1</div>
          <div class="info-value">${escapeHtml(partida.atleta1 || '-')}</div>
        </div>
        <div class="info-card">
          <div class="info-label">Atleta 2</div>
          <div class="info-value">${escapeHtml(partida.atleta2 || '-')}</div>
        </div>
      </div>
    </div>

    <div class="bloco">
      <h2>Placares dos Sets</h2>
      <table>
        <thead>
          <tr>
            <th>Set</th>
            <th>Pontos da Dupla</th>
            <th>Pontos do Adversário</th>
          </tr>
        </thead>
        <tbody>
          ${gerarLinhasSets(sets)}
        </tbody>
      </table>
    </div>

    <div class="bloco evitar-quebra">
    <h2>Estatísticas</h2>
      <table>
        <thead>
        <tr>
          <th>Fundamento</th>
          <th>Total</th>
          <th>Neutro</th>
          <th>Pontos</th>
          <th>Erros</th>
          <th>Aproveitamento</th>
          <th>Eficiência</th>
        </tr>
        </thead>
        <tbody>
          ${gerarLinhasEstatisticas(estatisticas)}
        </tbody>
      </table>
    </div>

   <div class="bloco page-break">
  <h2>Detalhamento por Fundamento</h2>
      ${gerarBlocosDetalhamento(detalhamento)}
    </div>

    <div class="rodape">
      Documento gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Maceio' })}
    </div>
  </body>
  </html>
  `;
}

// -------------------------
// CADASTRO
// -------------------------
app.post('/auth/cadastro', async (req, res) => {
  try {
    const { nome, email, senha } = req.body;

    if (!nome || !email || !senha) {
      return res.status(400).json({ erro: 'Nome, email e senha são obrigatórios.' });
    }

    const nomeLimpo = String(nome).trim();
    const emailLimpo = String(email).trim().toLowerCase();
    const senhaLimpa = String(senha);

    if (nomeLimpo.length < 2) {
      return res.status(400).json({ erro: 'Nome muito curto.' });
    }

    if (senhaLimpa.length < 6) {
      return res.status(400).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
    }

    const usuarioExistente = await queryAsync(
      'SELECT id FROM usuarios WHERE email = ? LIMIT 1',
      [emailLimpo]
    );

    if (usuarioExistente.length > 0) {
      return res.status(409).json({ erro: 'Este email já está cadastrado.' });
    }

    const senhaHash = await bcrypt.hash(senhaLimpa, 10);

    const result = await queryAsync(
      'INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)',
      [nomeLimpo, emailLimpo, senhaHash]
    );

    return res.status(201).json({
      mensagem: 'Usuário cadastrado com sucesso.',
      usuario: {
        id: result.insertId,
        nome: nomeLimpo,
        email: emailLimpo
      }
    });
  } catch (error) {
    console.error('Erro no cadastro:', error);
    return res.status(500).json({ erro: 'Erro ao cadastrar usuário.' });
  }
});

// -------------------------
// LOGIN
// -------------------------
app.post('/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(400).json({ erro: 'Email e senha são obrigatórios.' });
    }

    const emailLimpo = String(email).trim().toLowerCase();
    const senhaLimpa = String(senha);

    const usuarios = await queryAsync(
      'SELECT id, nome, email, senha_hash FROM usuarios WHERE email = ? LIMIT 1',
      [emailLimpo]
    );

    if (usuarios.length === 0) {
      return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    }

    const usuario = usuarios[0];
    const senhaCorreta = await bcrypt.compare(senhaLimpa, usuario.senha_hash);

    if (!senhaCorreta) {
      return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ erro: 'JWT_SECRET não configurado no .env.' });
    }

    const token = jwt.sign(
      {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      mensagem: 'Login realizado com sucesso.',
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email
      }
    });
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({ erro: 'Erro ao fazer login.' });
  }
});

// -------------------------
// USUÁRIO LOGADO
// -------------------------
app.get('/auth/me', verificarToken, async (req, res) => {
  return res.json({
    usuario: req.usuario
  });
});

// -------------------------
// PARTIDAS
// -------------------------
app.post('/partidas', verificarToken, async (req, res) => {
  try {
    const { campeonato, local, adversario, data_partida, atleta1, atleta2 } = req.body;

    if (!campeonato || !local || !adversario || !data_partida || !atleta1 || !atleta2) {
      return res.status(400).json({ erro: 'Todos os campos da partida são obrigatórios.' });
    }

    const sql = `
      INSERT INTO partidas (
        campeonato,
        local,
        adversario,
        data_partida,
        dupla,
        atleta1,
        atleta2,
        resultado,
        id_usuario
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Em andamento', ?)
    `;

    const result = await queryAsync(sql, [
      String(campeonato).trim(),
      String(local).trim(),
      String(adversario).trim(),
      data_partida,
     `${String(atleta1).trim()} / ${String(atleta2).trim()}`,
      String(atleta1).trim(),
      String(atleta2).trim(),
      req.usuario.id
    ]);

    return res.status(201).json({ id_partida: result.insertId });
  } catch (error) {
    console.error('Erro ao criar partida:', error);
    return res.status(500).json({ erro: 'Erro ao criar partida.' });
  }
});

app.get('/partidas', verificarToken, async (req, res) => {
  try {
    const result = await queryAsync(
      'SELECT * FROM partidas WHERE id_usuario = ? ORDER BY data_partida DESC, id DESC',
      [req.usuario.id]
    );

    return res.json(result);
  } catch (error) {
    console.error('Erro ao buscar partidas:', error);
    return res.status(500).json({ erro: 'Erro ao buscar partidas.' });
  }
});

app.post('/partidas/:id/finalizar', verificarToken, async (req, res) => {
  try {
    const idPartida = Number(req.params.id);
    const { sets } = req.body;

    if (!Array.isArray(sets) || sets.length < 2) {
      return res.status(400).json({ erro: 'Envie os sets corretamente.' });
    }

    const partida = await buscarPartidaDoUsuario(idPartida, req.usuario.id);
    if (!partida) {
      return res.status(404).json({ erro: 'Partida não encontrada.' });
    }

    await queryAsync('DELETE FROM sets_partida WHERE id_partida = ?', [idPartida]);

    for (const set of sets) {
      await queryAsync(
        `
        INSERT INTO sets_partida (id_partida, set_numero, pontos_dupla, pontos_adversario)
        VALUES (?, ?, ?, ?)
        `,
        [
          idPartida,
          Number(set.set_numero),
          Number(set.pontos_dupla),
          Number(set.pontos_adversario)
        ]
      );
    }

    const final = calcularResultadoFinal(sets);

    await queryAsync(
      'UPDATE partidas SET resultado = ? WHERE id = ? AND id_usuario = ?',
      [final, idPartida, req.usuario.id]
    );

    return res.json({ resultado: final });
  } catch (error) {
    console.error('Erro ao finalizar partida:', error);
    return res.status(500).json({ erro: 'Erro ao finalizar partida.' });
  }
});

// -------------------------
// EVENTOS
// -------------------------
app.post('/evento', verificarToken, async (req, res) => {
  try {
    const { id_partida, id_atleta, set_numero, fundamento, resultado } = req.body;

    if (!id_partida || !id_atleta || !set_numero || !fundamento || !resultado) {
      return res.status(400).json({ erro: 'Dados do evento incompletos.' });
    }

    const partida = await buscarPartidaDoUsuario(Number(id_partida), req.usuario.id);
    if (!partida) {
      return res.status(404).json({ erro: 'Partida não encontrada.' });
    }

    await queryAsync(
      `
      INSERT INTO eventos_partida (id_partida, id_atleta, set_numero, fundamento, resultado)
      VALUES (?, ?, ?, ?, ?)
      `,
      [
        Number(id_partida),
        Number(id_atleta),
        Number(set_numero),
        String(fundamento).trim(),
        String(resultado).trim()
      ]
    );

    return res.json({ mensagem: 'Evento salvo com sucesso!' });
  } catch (error) {
    console.error('Erro ao salvar evento:', error);
    return res.status(500).json({ erro: 'Erro ao salvar evento.' });
  }
});

app.delete('/evento/ultimo/:id_partida', verificarToken, async (req, res) => {
  try {
    const idPartida = Number(req.params.id_partida);

    const partida = await buscarPartidaDoUsuario(idPartida, req.usuario.id);
    if (!partida) {
      return res.status(404).json({ erro: 'Partida não encontrada.' });
    }

    const ultimoEvento = await queryAsync(
      `
      SELECT id
      FROM eventos_partida
      WHERE id_partida = ?
      ORDER BY id DESC
      LIMIT 1
      `,
      [idPartida]
    );

    if (!ultimoEvento.length) {
      return res.status(404).json({ erro: 'Nenhum evento encontrado para desfazer.' });
    }

    await queryAsync(
      'DELETE FROM eventos_partida WHERE id = ?',
      [ultimoEvento[0].id]
    );

    return res.json({ mensagem: 'Último clique desfeito com sucesso!' });
  } catch (error) {
    console.error('Erro ao desfazer último evento:', error);
    return res.status(500).json({ erro: 'Erro ao desfazer último evento.' });
  }
});

// -------------------------
// DADOS DO RELATÓRIO
// -------------------------
app.get('/partida/:id/dados-relatorio', verificarToken, async (req, res) => {
  try {
    const idPartida = Number(req.params.id);
    const tipo = req.query.tipo || 'dupla';

    const dados = await buscarDadosRelatorio(idPartida, tipo, req.usuario.id);

    if (!dados) {
      return res.status(404).json({ erro: 'Partida não encontrada.' });
    }

    return res.json({
      partida: {
        id: dados.partida.id,
        id_partida: dados.partida.id,
        campeonato: dados.partida.campeonato || '',
        local: dados.partida.local || '',
        adversario: dados.partida.adversario || '',
        data_partida: dados.partida.data_partida || '',
        resultado: dados.partida.resultado || '',
        dupla: dados.partida.dupla || `${dados.partida.atleta1 || 'Atleta 1'} / ${dados.partida.atleta2 || 'Atleta 2'}`,
        atleta1: dados.partida.atleta1 || 'Atleta 1',
        atleta2: dados.partida.atleta2 || 'Atleta 2',
        data_formatada: formatarDataBR(dados.partida.data_partida)
      },
      sets: dados.sets || [],
      estatisticas: {
        ataque: dados.estatisticas['ataque'] || { total: 0, neutros: 0, pontos: 0, erros: 0, aproveitamento: 0, eficiencia: 0 },
        saque: dados.estatisticas['saque'] || { total: 0, neutros: 0, pontos: 0, erros: 0, aproveitamento: null, eficiencia: null },
        passe: dados.estatisticas['passe'] || { total: 0, neutros: 0, pontos: 0, erros: 0, aproveitamento: 0, eficiencia: 0 },
        bloqueio: dados.estatisticas['bloqueio'] || { total: 0, neutros: 0, pontos: 0, erros: 0, aproveitamento: null, eficiencia: null },
        defesa: dados.estatisticas['defesa'] || { total: 0, neutros: 0, pontos: 0, erros: 0, aproveitamento: 0, eficiencia: 0 },
        'side-out': dados.estatisticas['side-out'] || { total: 0, neutros: 0, pontos: 0, erros: 0, aproveitamento: 0, eficiencia: 0 },
        'contra-ataque': dados.estatisticas['contra-ataque'] || { total: 0, neutros: 0, pontos: 0, erros: 0, aproveitamento: 0, eficiencia: 0 }
      },
      detalhamento: {
        ataque: dados.detalhamento['ataque'] || {},
        saque: dados.detalhamento['saque'] || {},
        passe: dados.detalhamento['passe'] || {},
        bloqueio: dados.detalhamento['bloqueio'] || {},
        defesa: dados.detalhamento['defesa'] || {},
        'side-out': dados.detalhamento['side-out'] || {},
        'contra-ataque': dados.detalhamento['contra-ataque'] || {}
      }
    });
  } catch (error) {
    console.error('Erro ao buscar dados do relatório:', error);
    return res.status(500).json({ erro: 'Erro interno ao buscar dados do relatório.' });
  }
});

// -------------------------
// RELATÓRIO PDF COM PUPPETEER
// -------------------------
app.get('/relatorio/:id_partida/:tipo/pdf', verificarToken, async (req, res) => {
  let browser;

  try {
    const idPartida = Number(req.params.id_partida);
    const tipo = req.params.tipo || 'dupla';

    const dados = await buscarDadosRelatorio(idPartida, tipo, req.usuario.id);

    if (!dados) {
      return res.status(404).json({ erro: 'Partida não encontrada.' });
    }

    const html = gerarHtmlRelatorio({
    partida: dados.partida,
    sets: dados.sets,
    estatisticas: dados.estatisticas,
    detalhamento: dados.detalhamento,
    tipo
    });

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      dumpio: true
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px'
      }
    });

    const nomeArquivo = `relatorio-${tipo}-partida-${idPartida}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Erro ao gerar PDF com Puppeteer:', error);
    return res.status(500).json({ erro: 'Erro ao gerar PDF.' });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

// -------------------------
// 404
// -------------------------
app.use((req, res) => {
  return res.status(404).json({ erro: 'Rota não encontrada.' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});