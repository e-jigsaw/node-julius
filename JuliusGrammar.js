/* ------------------------------------------------------------------------- */
// ライブラリの読み込み
/* ------------------------------------------------------------------------- */
var Gin       = require('./gin.js')
  ; path      = require('path')
  ; exec      = require('child_process').exec
  ; fs        = require('fs')
  ; async     = require('async')
  ; kana2voca = require('kana2voca').sync
  ; MeCab     = require('mecab-async')
  ; mecab     = new MeCab()
;

/* ------------------------------------------------------------------------- */
// 便利関数
/* ------------------------------------------------------------------------- */
/**
 * 文字列を n 回繰り返す
 * @param[in] num 繰り返し回数
 */
String.prototype.repeat = function( num ) {
	for(var i = 0, buf = ""; i < num; ++i) buf += this;
	return buf;
}

/**
 * 数字を漢字に変換する
 * @param[in] num 整数（１京未満）
 */
Number.prototype.toKanji = function() {
	var num = this;
	if (num === 0) return 'ゼロ';
	if (num >= 10000000000000000) return '無理でした';
	var numKanji    = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
	  , ketaKanji   = ['', '十', '百', '千']
	  , kuraiKanji  = ['', '万', '億', '兆']
	  , resultKanji = ''
	;
	if (num < 0) {
		resultKanji += 'マイナス';
		num *= -1;
	}
	// 92
	var keta  = num.toString().length
	  , kurai = 0
	;
	while (num > 0) {
		var k = keta - num.toString().length
		  , x = num%10
		  , c = (k%4 === 0) ? kurai : 0
		;
		if (k%4 === 0) ++kurai;
		if (x === 0) k = 0; // ０のつく桁は省く
		if (k > 0 && x === 1) x = 0; // 一桁目以外は '一' を省く
		resultKanji = numKanji[x] + ketaKanji[k%4] + kuraiKanji[c] + resultKanji;
		num = Math.floor(num/10);
	}
	return resultKanji;
}

/**
 * 文字列をカタカナに変換する
 */
String.prototype.toKana = function() {
	var result = mecab.parseSync( this.toString() )
	  , kana = ''
	;
	for (var i in result) {
		if (!result[i][9]) {
			if (result[i][2] === '数' && !result[i][9]) {
				kana += parseInt(result[i][0]).toKanji().toKana();
			} else {
				kana += result[i][0];
			}
		} else {
			kana += result[i][9];
		}
	}
	return kana;
}

/**
 * 文字列をvoca形式に変換する
 */
String.prototype.toVoca = function() {
	var kana = this.toString().toKana();
	return kana2voca(kana);
}

/* ------------------------------------------------------------------------- */
// Gin による構文解析
/* ------------------------------------------------------------------------- */

//! Julius の形式に変換するための Grammar
var Voca = new Gin.Grammar({
	Expr     : / ((Group|Symbol|String)(MinMax|Repeat|Plus|Asterisk|Question)?)+ /,
	Group    : / [(]:child Expr ([|]:bros Expr)* [)]:unchild /,
	MinMax   : / [{] $INT:min [,] $INT:max [}] /,
	Repeat   : / [{] $INT:repeat [}] /,
	Plus     : / [+]:plus /,
	Asterisk : / [*]:asterisk /,
	Question : / [?]:question /,
	Symbol   : / [<] $SYMBOL:symbol [>] /,
	String   : / $STRING:string /
}, 'Expr', Gin.SPACE);

//! 文字列ノードのタイプ
const NODE_TYPE = {
	STRING   : 0,
	SYMBOL   : 1
};

//! 文字列ノードの繰り返しタイプ
const REPEAT_TYPE = {
	NONE         : 0, // 繰り返しなし
	MIN_AND_MAX  : 1, // 繰り返しの最小/最大数を設定
	ONE_OR_MORE  : 2, // ０回以上の繰り返し
	ZERO_OR_MORE : 3  // １回以上の繰り返し
};

/**
 * 文字列ノードクラス.
 * 各ノードの情報を格納する（e.g. 繰り返し回数、次のノード、子ノード）
 */
function Node() {
	this.str    = '';
	this.id     = '';
	this.repeat = REPEAT_TYPE.NONE;
	this.type   = NODE_TYPE.STRING;
	this.parent = null;
	this.child  = null;
	this.next   = null;
	this.min    = -1;
	this.max    = -1;
	this.isNextBros   = false;
}

/**
 * Gin の Semantic Action を引き受けるハンドラ.
 */
var Handler = function() {
	//! 最初のノード位置
	this.first = new Node();

	//! 現在のノード位置
	this.node = this.first;
}
Handler.prototype = {
	//! 現在のノード位置 or 次の位置へ文字列ノードを追加
	string: function(v) {
		if (this.node.str !== '' || this.node.child !== null) {
			this.node.next = new Node();
			this.node.next.parent = this.node.parent;
			this.node = this.node.next;
		}
		this.node.str = v;
	},
	//! 現在のノード位置 or 次の位置へ数字ノードを追加
	symbol: function(v) {
		if (this.node.str != '' || this.node.child != null) {
			this.node.next = new Node();
			this.node.next.parent = this.node.parent;
			this.node = this.node.next;
		}
		this.node.str  = v;
		this.node.type = NODE_TYPE.SYMBOL;
	},
	//! 最小繰り返し回数を設定
	min: function(v) {
		this.node.repeat = REPEAT_TYPE.MIN_AND_MAX;
		this.node.min = v;
	},
	//! 最大繰り返し回数を設定
	max: function(v) {
		this.node.repeat = REPEAT_TYPE.MIN_AND_MAX;
		this.node.max = v;
	},
	//! 固定繰り返し回数を設定
	repeat: function(v) {
		this.node.repeat = REPEAT_TYPE.MIN_AND_MAX;
		this.node.min = this.node.max = v;
	},
	//! １回以上繰り返しに設定
	plus: function(v) {
		this.node.repeat = REPEAT_TYPE.ONE_OR_MORE;
	},
	//! ０回以上繰り返しに設定
	asterisk: function(v) {
		this.node.repeat = REPEAT_TYPE.ZERO_OR_MORE;
	},
	//! ０回か１回出現に設定
	question: function(v) {
		this.node.repeat = REPEAT_TYPE.MIN_AND_MAX;
		this.node.min = 0;
		this.node.max = 1;
	},
	//! 自分の次のノードが兄弟ノードかどうかを記憶
	bros: function(v) {
		this.node.isNextBros = true;
	},
	//! 子要素を設定し現在のノード位置を子ノードへ移動
	child: function(v) {
		this.node.next = new Node();
		this.node.next.parent = this.node.parent;
		this.node.next.child = new Node();
		this.node.next.child.parent = this.node.next;
		this.node = this.node.next.child;
	},
	//! 現在のノード位置を親ノードへ移動
	unchild: function(v) {
		this.node = this.node.parent;
	}
};


/**
 * Julius の文法に必要なファイルを生成する
 */
var JuliusData = function() {
	this.num_             = 0;
	this.DEFAULT_VOCA_STR = '% NS_B\n<s>\tsilB\n% NS_E\n<s>\tsilE\n% NOISE\n<sp>\tsp\n';
	this.DEFAULT_GRAM_STR = 'S\t: NS_B NOISE NS_E\n';
	this.voca_            = this.DEFAULT_VOCA_STR;
	this.grammar_         = this.DEFAULT_GRAM_STR;
	this.fileName_        = 'tmp';
	this.mkdfaPath_       = path.join(__dirname, 'tool/mkdfa');
	this.generatePath_    = path.join(__dirname, 'tool/generate');
}

JuliusData.prototype = {
	/**
	 * Gin による構文解析結果から Julius の grammar 形式、voca 形式を生成する.
	 * 解析結果（Nodeクラス）は兄弟/子供を持つので、再帰的に子供を調べる
	 *
	 * @param[in] firstNum      grammar や voca で用いる ID 番号
	 * @param[in] firstNode     Gin によって解析された結果のノード
	 * @param[in] parentId      (再帰で使用) 親の ID. （e.g. WORD_5 など）
	 * @return                  {grammar, voca, num} 構造体
	 */
	makeJuliusFormat: function (firstNum, firstNode, parentId) {
		var num = firstNum;
		var gramStr = '', vocaStr = '';

		// 最上位ノードの場合
		if (parentId === undefined) {
			// ルートとなる文法を作成する
			// 繰り返し用に最上位ノードの場合は ROOT_N --> WORD_N という対応付けをする
			var rootGramStr = '';
			gramStr += 'S\t: NS_B ';
			for (var node = firstNode, n = firstNum; node; node = node.next) {
				if (node.child !== null || node.str !== '') {
					rootGramStr += 'ROOT_' + n + '\t: WORD_' + n + '\n';
					gramStr += 'ROOT_' + n + ' ';
					++n;
				}
			}
			gramStr += 'NS_E\n';
			gramStr += rootGramStr;
		}

		// ノードを順に走査（next）
		for (var node = firstNode; node; node = node.next) {
			// 子ノードがいないかつ空ノード（頭とか）は無視
			if (node.child === null && node.str === '') continue;

			// 自身の ID を設定 (最上位ノードかどうかで場合分け）
			var id, parentId2;
			if (parentId === undefined) {
				parentId2 = 'ROOT_' + num;
				id = 'WORD_' + num;
			} else {
				parentId2 = parentId;
				id = parentId + '_' + num;
			}

			// 繰り返しに対応する grammar を作る
			var loopId = id + '_LOOP'; tmpId = id + '_TMP';
			switch (node.repeat) {
				case REPEAT_TYPE.NONE:
					break;
				case REPEAT_TYPE.MIN_AND_MAX:
					for (var i = node.min; i <= node.max; ++i) {
						if (i === 0)
							gramStr += id + '\t: NOISE\n';
						else
							gramStr += id + '\t: ' + (loopId + ' ').repeat(i) + '\n';
					}
					id = loopId;
					break;
				case REPEAT_TYPE.ZERO_OR_MORE:
					gramStr += id + '\t: NOISE\n';
					gramStr += id + '\t: ' + loopId + '\n';
					gramStr += id + '\t: ' + id + ' ' + loopId + '\n';
					id = loopId;
					break;
				case REPEAT_TYPE.ONE_OR_MORE:
					gramStr += id + '\t: ' + loopId + '\n';
					gramStr += id + '\t: ' + id + ' ' + loopId + '\n';
					id = loopId;
					break;
				default:
					throw new Error("ERROR! Invalid REPEAT_TYPE.");
					break;
			}

			// 再帰処理
			// 子ノード（= child）がいるとき（= 自分の str は空）、子ノードを走査
			if (node.child !== null) {
				// 文法を作成
				// isNextBros が設定されているノードの時はそこの位置がセパレータとなる
				gramStr += id + '\t: ';
				for (var child = node.child, m = 0; child; child = child.next, ++m) {
					gramStr += id + '_' + m + ' ';
					if (child.isNextBros === true) {
						gramStr += '\n' + id + '\t: ';
					}
				}
				gramStr += '\n';

				var result;
				// 親IDに自分のIDをひもづける
				result = this.makeJuliusFormat(0, node.child, id);
				gramStr += result.grammar;
				vocaStr += result.voca;
				++num;
			}


			// 子ノードがいないが空でないノードの場合(= 終端ノード)は voca を書きだして次へ
			if (node.child === null && node.str !== '') {
				// MeCab と ICU を用いて Julius の voca 形式に変換
				// Symbol なら voca 形式に登録せずに grammar に追加
				switch (node.type) {
					case NODE_TYPE.STRING:
						vocaStr +=
							'% ' + id + '\n' +
							node.str + '\t' + node.str.toVoca() + '\n';
						break;
					case NODE_TYPE.SYMBOL:
						gramStr += id + '\t: ' + node.str + '\n';
						break;
					default:
						throw new Error("ERROR! Invalid NODE_TYPE.");
						break;
				}
				++num;
			}

		}
		return {grammar: gramStr, voca: vocaStr, num: num};
	},

	/**
	 * Julius が認識することのできる文字列を追加
	 * @param[in] str 追加する表現
	 */
	add: function(str) {
		var handler = new Handler();
		var match   = Voca.parse(str, handler);

		if (match && match.full) {
			var result     = this.makeJuliusFormat(this.num_, handler.first);
			this.voca_    += result.voca;
			this.grammar_ += result.grammar;
			this.num_      = result.num;
		} else {
			throw new Error('ERROR! "' + str + '" is invalid format.');
		}
	},

	/**
	 * symbol を追加.
	 * @param[in] symbol 追加するシンボル
	 * @param[in] arr    シンボルに対応する文字列配列
	 * @param[in] sArr   arr を ['一', '二']、sArr を ['1', '2'] として渡すと voca が '1 i ch i \n 2 n i' となる。
	 */
	addSymbol: function(symbol, arr) {
		if (!/[a-zA-Z0-9_-]/.test(symbol)) {
			throw new Error('ERROR! "' + symbol + '" is invalid symbol.');
		}
		this.voca_ += '% ' + symbol + '\n';
		for (var i in arr) {
			var str     = arr[i].toString();
			this.voca_ += str + '\t' + str.toVoca() + '\n';
		}
	},

	/**
	 * voca と grammar をリセットする
	 */
	reset : function() {
		this.voca_    = this.DEFAULT_VOCA_STR;
		this.grammar_ = this.DEFAULT_GRAM_STR;
	},

	/**
	 * voca / grammar / dfa / dict / term を削除する
	 * @param[in] callback 処理が終了した時に実行されるコールバック
	 */
	deleteFiles : function(callback) {
		var command = 'rm ';
		['.voca', '.grammar', '.dfa', '.dict', '.term'].forEach(function(ext) {
			command += this.fileName_ + ext + ' ';
		}.bind(this));
		exec(command, function(err, stdout, stderr) {
			if (err)    next(err,    null);
			if (stderr) next(stderr, null);
			if ( typeof(callback) == 'function' ) callback(null, stdout);
		});
	},

	/**
	 * 出力するファイル名を出力
	 * @param[in] fileName 出力ファイル名
	 */
	setFileName: function(fileName) {
		this.fileName_ = fileName;
	},

	/**
	 * voca / grammar ファイルを書き出して mkdfa を実行する
	 * @param[in] callback 処理が終了した時に実行されるコールバック
	 */
	mkdfa: function(callback) {
		async.series({
			voca: function(next) {
				var fileName = this.fileName_ + '.voca';
				fs.writeFile(fileName, this.voca_, next);
			}.bind(this),
			grammar: function(next) {
				var fileName = this.fileName_ + '.grammar';
				fs.writeFile(fileName, this.grammar_, next);
			}.bind(this),
			mkdfa: function(next) {
				var command = this.mkdfaPath_ + ' ' + this.fileName_;
				exec(command, function(err, stdout, stderr) {
					if (err) {
						next(err, null);
						return;
					}
					var result = {stderr: stderr, stdout: stdout};
					if ( typeof(callback) == 'function' ) {
						next(null, result);
					}
				});
			}.bind(this)
		},
		function(err, result) {
			callback(err, result.mkdfa);
		});
	},

	/**
	 * 生成したファイルを generate を用いてテストする
	 */
	test: function(callback) {
		var command = this.generatePath_ + ' ' + this.fileName_;
		exec(command, function(err, stdout, stderr) {
			if (err) {
				callback(err, null);
				return;
			}
			var result = {stderr: stderr, stdout: stdout};
			if ( typeof(callback) == 'function' ) {
				callback(null, result);
			}
		});
	}
};

/* ------------------------------------------------------------------------- */
// エクスポート
/* ------------------------------------------------------------------------- */
module.exports = JuliusData;