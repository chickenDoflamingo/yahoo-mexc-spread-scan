import pandas as pd
import glob
import os

def load_exchange(files, exchange_name):
    usecols = ['time_exchange', 'update_type', 'is_buy', 'entry_px', 'entry_sx', 'order_id']
    dtype_map = {'update_type': 'category', 'is_buy': 'int8', 'entry_px': 'float64', 'entry_sx': 'float64',
                 'order_id': 'string'}
    dfs = []
    for file in files:
        file_name = os.path.basename(file)
        symbol = file_name.split('.')[0].split('_')[-1]
        df = pd.read_csv(file, sep=";", usecols=usecols, dtype=dtype_map)
        df['exchange'] = exchange_name
        df['symbol'] = symbol
        df['time_exchange'] = pd.to_datetime(df['time_exchange'], format='%H:%M:%S.%f', utc=True)
        dfs.append(df)

    df_final = pd.concat(dfs, ignore_index=True)
    df_final['exchange'] = pd.Categorical(df_final['exchange'])
    df_final['symbol'] = pd.Categorical(df_final['symbol'])
    df_final = df_final.sort_values('time_exchange')
    return df_final


base_path = '/Users/mac/Downloads/l2_case_20260127_0100_0400_bybit_kucoinfts/raw/T-LIMITBOOK_FULL'
files_bybit = sorted(glob.glob(base_path + '/**/E-BYBIT/*.csv.gz', recursive=True))
files_kucoin = sorted(glob.glob(base_path + '/**/E-KUCOINFTS/*.csv.gz', recursive=True))

df_bybit = load_exchange(files_bybit, 'bybit')
df_kucoin = load_exchange(files_kucoin, 'kucoinfts')

print(df_bybit.head(3), df_kucoin.head(3), df_bybit.info(), df_kucoin.info(), df_bybit['time_exchange'].dtype, df_kucoin['time_exchange'].dtype)
