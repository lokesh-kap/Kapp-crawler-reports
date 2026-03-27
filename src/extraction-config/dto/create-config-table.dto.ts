import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateConfigTableDto {
  @IsString()
  @IsIn(['leads', 'summary'])
  config_type: 'leads' | 'summary';

  @IsInt()
  @Min(1)
  config_id: number;

  @IsString()
  row_selector: string;

  @IsOptional()
  @IsString()
  next_selector?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

