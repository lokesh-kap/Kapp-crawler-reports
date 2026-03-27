import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateConfigTableFieldDto {
  @IsInt()
  @Min(1)
  table_id: number;

  @IsString()
  field_key: string;

  @IsString()
  db_column: string;

  @IsString()
  selector: string;

  @IsOptional()
  @IsString()
  @IsIn(['text', 'attr'])
  data_type?: 'text' | 'attr';

  @IsOptional()
  @IsString()
  attribute?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sequence?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

