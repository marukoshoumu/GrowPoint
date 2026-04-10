"""
ファイル命名ロジック。
GAS の getChunkTranscriptBasePrefix_ / formatChunkTranscriptIndexPad_ と完全一致する出力を保証する。
"""


def _transcript_base_prefix(date: str, user_name: str) -> str:
    """GAS: getChunkTranscriptBasePrefix_ と同等"""
    return f"{date}_{user_name}_文字起こし"


def _chunk_index_pad(chunk_index: int, chunk_total: int) -> str:
    """GAS: formatChunkTranscriptIndexPad_ と同等。最低2桁ゼロ埋め。"""
    width = max(len(str(chunk_total)), 2)
    return str(chunk_index).zfill(width)


def transcript_filename(date: str, user_name: str) -> str:
    """単一ファイル用: {date}_{userName}_文字起こし.txt"""
    return _transcript_base_prefix(date, user_name) + ".txt"


def chunk_transcript_filename(
    date: str, user_name: str, chunk_index: int, chunk_total: int
) -> str:
    """チャンク用: {date}_{userName}_文字起こし_{NN}.txt"""
    pad = _chunk_index_pad(chunk_index, chunk_total)
    return _transcript_base_prefix(date, user_name) + "_" + pad + ".txt"
